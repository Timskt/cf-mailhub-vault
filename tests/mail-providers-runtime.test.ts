import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("provider transport runs in Workers and never follows credential redirects", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { providerDomains, providerLogin } from './src/mail-providers';
        export default {
          async fetch(request) {
            const redirect = new URL(request.url).searchParams.has('redirect');
            const calls = [];
            const originalFetch = globalThis.fetch;
            globalThis.fetch = async (input, init) => {
              // The real Workerd constructor rejects unsupported fetch options.
              const upstream = new Request(input, init);
              const url = new URL(upstream.url);
              calls.push({host:url.hostname,path:url.pathname,redirect:upstream.redirect});
              if (redirect) return new Response('', {
                status:307, headers:{Location:'https://untrusted.test/credentials'}
              });
              if (url.pathname === '/domains') return Response.json({
                'hydra:member':[{domain:'example.test',isActive:true,isPrivate:false}],
                'hydra:totalItems':1
              });
              if (url.pathname === '/token') return Response.json({
                id:'fictional-id',token:'fictional-token'
              });
              return Response.json({id:'fictional-id',address:'owned@example.test'});
            };
            const results = [];
            try {
              for (const provider of ['mailtm','mailgw']) {
                for (const action of [
                  () => providerDomains(provider),
                  () => providerLogin(provider,'owned@example.test','fictional-password'),
                ]) {
                  try { results.push({data:await action()}); }
                  catch (error) { results.push({code:error.code,status:error.status}); }
                }
              }
              return Response.json({results,calls});
            } finally { globalThis.fetch = originalFetch; }
          }
        };
      `,
      resolveDir: process.cwd(),
      sourcefile: "providers-runtime-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "providers-runtime-test",
          compatibilityDate: "2026-11-01",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
            },
          },
        },
      },
    ],
  });
  try {
    const worker = await runtime.getWorker();
    const success = (await (
      await worker.fetch("https://mailhub.test/")
    ).json()) as any;
    assert.equal(success.calls.length, 6);
    for (const offset of [0, 2]) {
      assert.deepEqual(success.results[offset].data.data, [
        { domain: "example.test" },
      ]);
      assert.equal(success.results[offset + 1].data.token, "fictional-token");
      assert.equal(success.results[offset + 1].data.remote_id, "fictional-id");
    }
    const rejected = (await (
      await worker.fetch("https://mailhub.test/?redirect=1")
    ).json()) as any;
    assert.equal(rejected.calls.length, 4);
    for (const result of rejected.results) {
      assert.equal(result.code, "PROVIDER_UNAVAILABLE");
      assert.equal(result.status, 502);
    }
    for (const call of [...success.calls, ...rejected.calls]) {
      assert.ok(["api.mail.tm", "api.mail.gw"].includes(call.host));
      assert.equal(call.redirect, "manual");
    }
  } finally {
    await runtime.dispose();
  }
});
