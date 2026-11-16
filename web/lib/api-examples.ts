type Schema = Record<string, unknown>;
export type SnippetEntry = {
  method: string;
  path: string;
  parameters: {
    name: string;
    in: string;
    required?: boolean;
    schema: Schema;
    example?: unknown;
  }[];
  "x-auth-mode": "public" | "key" | "admin" | "cookie";
  requestBody?: { content: { "application/json": { example?: unknown } } };
  responses: Record<string, { content?: Record<string, unknown> }>;
};
export function apiSnippet(
  entry: SnippetEntry,
  language: string,
  base: string,
) {
  let path = entry.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const parameter = entry.parameters.find(
      (p) => p.in === "path" && p.name === name,
    );
    const schema = parameter?.schema ?? {};
    const value =
      parameter?.example ??
      schema.example ??
      schema.default ??
      (schema.type === "integer" || schema.type === "number"
        ? (schema.minimum ?? 1)
        : name === "domain"
          ? "example.com"
          : `REPLACE_${name.toUpperCase()}`);
    return encodeURIComponent(String(value));
  });
  const params = entry.parameters.filter(
    (p) => p.in === "query" && (p.example !== undefined || p.required),
  );
  if (params.length)
    path +=
      "?" +
      new URLSearchParams(
        params.map((p) => [p.name, String(p.example ?? "REPLACE_VALUE")]),
      ).toString();
  const body = entry.requestBody?.content["application/json"].example ?? {};
  const hasBody = !!entry.requestBody;
  const authenticated = ["admin", "key"].includes(entry["x-auth-mode"]);
  const cookie = entry["x-auth-mode"] === "cookie";
  const jsonResponse = Object.entries(entry.responses).some(
    ([status, response]) =>
      /^2(?:\d{2}|XX)$/i.test(status) &&
      !!response.content?.["application/json"],
  );
  const idempotencyRequired = entry.parameters.some(
    (p) =>
      p.in === "header" &&
      p.name.toLowerCase() === "idempotency-key" &&
      p.required,
  );
  const idempotencyNote =
    "为本次获准操作生成并保存唯一幂等键，仅同次请求重试复用；结果未知时先核对状态，勿换键自动重试。";
  if (language === "javascript") {
    const headers = [
      ...(authenticated
        ? ["Authorization: `Bearer ${process.env.MAILHUB_API_KEY}`"]
        : []),
      ...(cookie ? ["Cookie: process.env.MAILHUB_ADMIN_COOKIE"] : []),
      ...(idempotencyRequired ? ['"Idempotency-Key": idempotencyKey'] : []),
      ...(hasBody ? ['"Content-Type": "application/json"'] : []),
    ];
    return `// Node.js 22+；MAILHUB_URL=${base}
const base = process.env.MAILHUB_URL.replace(/\\/$/, "");${
      idempotencyRequired
        ? `
// ${idempotencyNote}
const idempotencyKey = process.env.MAILHUB_IDEMPOTENCY_KEY;
if (!idempotencyKey) throw new Error("请设置 MAILHUB_IDEMPOTENCY_KEY");`
        : ""
    }
const response = await fetch(base + ${JSON.stringify(path)}, {
  method: "${entry.method}",
  headers: {
${headers.map((h) => `    ${h},`).join("\n")}
  },${
    hasBody
      ? `
  body: JSON.stringify(${JSON.stringify(body, null, 2).replaceAll("\n", "\n  ")}),`
      : ""
  }
  signal: AbortSignal.timeout(120_000),
});
${jsonResponse ? "const result = await response.json();\nif (!response.ok) throw new Error(result.error || result.message);\n// 使用 result；批次还须检查每一项 success。" : "if (!response.ok) throw new Error(`HTTP ${response.status}`);\nconst result = await response.arrayBuffer();"}`;
  }
  if (language === "python") {
    const headers = [
      ...(authenticated
        ? ['"Authorization": "Bearer " + os.environ["MAILHUB_API_KEY"]']
        : []),
      ...(cookie ? ['"Cookie": os.environ["MAILHUB_ADMIN_COOKIE"]'] : []),
      ...(idempotencyRequired ? ['"Idempotency-Key": idempotency_key'] : []),
    ];
    const pythonBody = JSON.stringify(body, null, 2)
      .replace(
        /("(?:\\.|[^"\\])*")|\b(true|false|null)\b/g,
        (match, quoted) =>
          quoted ||
          ({ true: "True", false: "False", null: "None" }[match as "true"] ??
            match),
      )
      .replaceAll("\n", "\n    ");
    return `import os
import requests

# MAILHUB_URL=${base}
base = os.environ["MAILHUB_URL"].rstrip("/")${
      idempotencyRequired
        ? `
# ${idempotencyNote}
idempotency_key = os.environ["MAILHUB_IDEMPOTENCY_KEY"]
if not idempotency_key:
    raise ValueError("请设置 MAILHUB_IDEMPOTENCY_KEY")`
        : ""
    }
response = requests.${entry.method.toLowerCase()}(
    base + ${JSON.stringify(path)},
    headers={
${headers.map((h) => `        ${h},`).join("\n")}
    },${
      hasBody
        ? `
    json=${pythonBody},`
        : ""
    }
    timeout=120,
)
response.raise_for_status()
result = response.${jsonResponse ? "json()" : "content"}
# 使用 result；批次还须检查每一项 success。`;
  }
  const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
  const flags = [
    ...(authenticated ? ['-H "Authorization: Bearer $MAILHUB_API_KEY"'] : []),
    ...(cookie ? ["--cookie cookies.txt"] : []),
    ...(idempotencyRequired
      ? ['-H "Idempotency-Key: $MAILHUB_IDEMPOTENCY_KEY"']
      : []),
    ...(hasBody
      ? [
          "-H 'Content-Type: application/json'",
          `--data ${quote(JSON.stringify(body, null, 2))}`,
        ]
      : []),
  ];
  return `# MAILHUB_URL=${base}
${idempotencyRequired ? `# ${idempotencyNote}\n: "\${MAILHUB_IDEMPOTENCY_KEY:?请设置并保存本次操作的幂等键}"\n` : ""}curl --fail-with-body --request ${entry.method} "$MAILHUB_URL${path}"${flags.map((flag) => ` \\\n  ${flag}`).join("")}`;
}
