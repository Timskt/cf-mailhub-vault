import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("Microsoft requests use Workers-supported redirect handling and reject redirects", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { getAccessToken, fetchEmails } from './src/graph';
        export default {
          async fetch(request) {
            const redirect = new URL(request.url).searchParams.has('redirect');
            let requests = 0;
            globalThis.fetch = async (input, init) => {
              // Use the real Workerd Request constructor, not Node's more permissive one.
              const upstream = new Request(input, init);
              requests++;
              if (upstream.redirect !== 'manual') throw new Error('Unsafe redirect policy');
              if (redirect) return new Response('', {status:302,headers:{Location:'https://untrusted.test'}});
              return Response.json(upstream.method === 'POST'
                ? {access_token:'fictional-access',refresh_token:'fictional-rotated-refresh'}
                : {value:[]});
            };
            const token = await getAccessToken('fictional-client','fictional-refresh');
            const mail = await fetchEmails('fictional-access');
            return Response.json({token,mail,requests});
          }
        };
      `,
      resolveDir: process.cwd(),
      sourcefile: "outlook-runtime-entry.ts",
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
          name: "outlook-runtime-test",
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
    assert.equal(success.token.token, "fictional-access");
    assert.equal(success.token.newRefreshToken, "fictional-rotated-refresh");
    assert.deepEqual(success.mail.data.items, []);
    assert.equal(success.requests, 2);
    const redirected = (await (
      await worker.fetch("https://mailhub.test/?redirect=1")
    ).json()) as any;
    assert.equal(redirected.token.error.code, "UNEXPECTED_REDIRECT");
    assert.equal(redirected.mail.error.code, "UNEXPECTED_REDIRECT");
    assert.equal(redirected.requests, 2);
  } finally {
    await runtime.dispose();
  }
});
