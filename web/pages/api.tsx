import {
  ActionError,
  BusyButton,
  CopyButton,
  ErrorState,
  Loading,
  PageHeader,
  Pick,
  SearchBox,
  SelectField,
  TextField,
} from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { FieldGroup } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useAction, useResource } from "@/lib/api";
import { apiSnippet } from "@/lib/api-examples";
import { useWorkspace } from "@/lib/context";
import type { MailboxHealth } from "@/lib/types";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Braces,
  Check,
  CircleAlert,
  Code2,
  ExternalLink,
  KeyRound,
  SearchCheck,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type Schema = Record<string, unknown>;
type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  description: string;
  schema: Schema;
  example?: unknown;
};
type Operation = {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: Parameter[];
  "x-auth-mode": "public" | "key" | "admin" | "cookie";
  "x-side-effects": string;
  "x-credential-response": boolean;
  requestBody?: {
    content: { "application/json": { schema: Schema; example?: unknown } };
  };
  responses: Record<
    string,
    { content?: Record<string, { schema: Schema; example?: unknown }> }
  >;
};
type Entry = Operation & { method: string; path: string };
type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};
type Capability = {
  workflows: { id: string; operations: string[]; description: string }[];
};
const authLabels = {
  public: "公开",
  key: "API Key",
  admin: "API Key / 登录会话",
  cookie: "管理员会话",
};

function CodeBlock({
  value,
  label = "复制代码",
}: {
  value: string;
  label?: string;
}) {
  return (
    <div className="api-code-wrap">
      <div className="api-code-actions">
        <CopyButton value={value} label={label} />
      </div>
      <pre className="api-code">
        <code>{value}</code>
      </pre>
    </div>
  );
}
function expanded(
  value: unknown,
  schemas: Record<string, Schema>,
  depth = 0,
): unknown {
  if (depth > 12 || !value || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((v) => expanded(v, schemas, depth + 1));
  const record = value as Schema;
  if (typeof record.$ref === "string")
    return expanded(
      schemas[record.$ref.split("/").at(-1)!] || record,
      schemas,
      depth + 1,
    );
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [
      k,
      expanded(v, schemas, depth + 1),
    ]),
  );
}
export default function ApiPage() {
  const workspace = useWorkspace();
  const [spec, setSpec] = useState<Spec>();
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState("catalog");
  const [selected, setSelected] = useState<Entry>();
  const opener = useRef<HTMLElement | null>(null);
  const detailTitle = useRef<HTMLHeadingElement | null>(null);
  const capabilities = useResource<Capability>("/api/capabilities");
  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    fetch("/openapi.json", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("接口文档暂时不可用");
        return r.json() as Promise<Spec>;
      })
      .then(setSpec)
      .catch((e) => {
        if (!controller.signal.aborted) setLoadError(e.message);
      });
    return () => controller.abort();
  }, [revision]);
  const entries = useMemo(
    () =>
      spec
        ? Object.entries(spec.paths).flatMap(([path, methods]) =>
            Object.entries(methods).map(([method, item]) => ({
              ...item,
              method: method.toUpperCase(),
              path,
            })),
          )
        : [],
    [spec],
  );
  const filtered = entries.filter(
    (e) =>
      (!tag || e.tags.includes(tag)) &&
      `${e.operationId} ${e.path} ${e.summary} ${e.description} ${e.method}`
        .toLowerCase()
        .includes(search.toLowerCase().trim()),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, totalPages);
  function open(entry: Entry) {
    opener.current = document.activeElement as HTMLElement;
    setSelected(entry);
  }
  const quick = [
    "lookupVerification",
    "batchLookupVerification",
    "inspectMailbox",
    "batchUpdateVaultAccounts",
  ];
  return (
    <>
      <PageHeader
        title="开发者中心"
        description="从一次查收到完整工作流，让脚本和 AI 都能准确使用你的邮箱。"
      >
        <Button variant="outline" asChild>
          <a href="/openapi.json" target="_blank" rel="noopener noreferrer">
            <Braces data-icon="inline-start" />
            OpenAPI
          </a>
        </Button>
        <Button variant="outline" asChild>
          <a href="/postman.json" download>
            <ArrowDownToLine data-icon="inline-start" />
            Postman
          </a>
        </Button>
        <Button variant="outline" asChild>
          <a href="/api-doc.md" target="_blank" rel="noopener noreferrer">
            <BookOpen data-icon="inline-start" />
            接入指南
          </a>
        </Button>
      </PageHeader>
      <div className="api-intro mb-6">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">OpenAPI 3.1</Badge>
            {spec && (
              <Badge variant="outline">
                {entries.length} 个操作 · v{spec.info.version}
              </Badge>
            )}
          </div>
          <h2 className="text-xl font-semibold tracking-tight">
            把邮箱接入你的工作流
          </h2>
          <p className="hidden max-w-2xl text-sm leading-6 text-muted-foreground sm:block">
            分配多域名邮箱、接入
            Outlook、批量查收、整理平台账号。每个接口都有参数、示例和返回说明。
          </p>
          <div className="hidden flex-wrap gap-2 sm:flex">
            {entries
              .filter((e) => quick.includes(e.operationId))
              .map((e) => (
                <Button
                  key={e.operationId}
                  size="sm"
                  variant="outline"
                  onClick={() => open(e)}
                >
                  {e.summary}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              ))}
          </div>
        </div>
        <div className="api-auth-note">
          <KeyRound className="size-5 text-muted-foreground" />
          <div>
            <p className="font-medium">服务端携带 API Key</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              在设置中创建有权限范围、有效期和邮箱限制的自动化密钥。密钥、存储、备份及微软授权管理使用管理员会话。
            </p>
            <Button
              variant="link"
              className="px-0"
              onClick={() => workspace.navigate("settings")}
            >
              前往密钥设置
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="catalog">接口目录</TabsTrigger>
          <TabsTrigger value="workflows">工作流 / AI</TabsTrigger>
          <TabsTrigger value="diagnose">接入诊断</TabsTrigger>
        </TabsList>
        <TabsContent value="catalog" className="flex flex-col gap-4">
          <div className="filter-bar">
            <SearchBox
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder="搜索接口、路径或 operationId"
            />
            <Pick
              value={tag}
              onChange={(v) => {
                setTag(v);
                setPage(1);
              }}
              label="接口分类"
              options={[
                ["", "全部分类"],
                ...[...new Set(entries.flatMap((e) => e.tags))].map(
                  (t) => [t, t] as const,
                ),
              ]}
            />
            <p className="text-sm text-muted-foreground" role="status">
              {filtered.length} 个操作
            </p>
          </div>
          {loadError ? (
            <ErrorState
              message={loadError}
              retry={() => setRevision((v) => v + 1)}
            />
          ) : !spec ? (
            <Loading />
          ) : !filtered.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>没有匹配的接口</EmptyTitle>
                <EmptyDescription>
                  试试邮箱、verification 或路径中的关键词。
                </EmptyDescription>
              </EmptyHeader>
              <Button
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setTag("");
                }}
              >
                清空筛选
              </Button>
            </Empty>
          ) : (
            <div className="api-directory">
              {filtered
                .slice((currentPage - 1) * 12, currentPage * 12)
                .map((entry) => (
                  <button
                    key={entry.operationId}
                    className="api-operation-row"
                    onClick={() => open(entry)}
                  >
                    <Badge variant="outline" className="w-16 justify-center">
                      {entry.method}
                    </Badge>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{entry.summary}</span>
                        {entry["x-credential-response"] && (
                          <Badge variant="secondary">含凭据</Badge>
                        )}
                      </div>
                      <code className="mt-1 block break-all text-xs text-muted-foreground">
                        {entry.path}
                      </code>
                    </div>
                    <span className="hidden text-xs text-muted-foreground sm:block">
                      {entry.tags[0]}
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
            </div>
          )}
          {!!filtered.length && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                第 {currentPage} / {totalPages} 页
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  <ArrowLeft data-icon="inline-start" />
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === totalPages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  下一页
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
        <TabsContent value="workflows">
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex flex-col gap-4">
              {capabilities.error ? (
                <ErrorState
                  message={capabilities.error}
                  retry={capabilities.reload}
                />
              ) : !capabilities.result ? (
                <Loading />
              ) : (
                capabilities.result.data.workflows.map((flow, i) => (
                  <Card key={flow.id}>
                    <CardHeader>
                      <CardTitle>
                        {
                          [
                            "查收验证码与验证链接",
                            "分配邮箱并登记平台",
                            "按平台批量整理账号",
                            "预览并应用邮件规则",
                            "接入 Outlook 并维护授权",
                          ][i]
                        }
                      </CardTitle>
                      <CardDescription>{flow.description}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ol className="flex flex-col gap-2">
                        {flow.operations.map((id, step) => {
                          const entry = entries.find(
                            (e) => e.operationId === id,
                          );
                          return (
                            <li key={id}>
                              <Button
                                variant="ghost"
                                className="h-auto w-full justify-start whitespace-normal py-2 text-left"
                                onClick={() => entry && open(entry)}
                                disabled={!entry}
                              >
                                <span className="text-muted-foreground">
                                  {step + 1}.
                                </span>
                                {entry?.summary || id}
                                <ArrowRight data-icon="inline-end" />
                              </Button>
                            </li>
                          );
                        })}
                      </ol>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>给 AI 一份准确的接口地图</CardTitle>
                  <CardDescription>
                    从能力发现开始，再按固定 operationId 调用。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="text-sm leading-6 text-muted-foreground">
                    指南包含参数约束、认证边界、空结果与失败的区别、重试策略，以及每个操作的副作用。
                  </p>
                  <CodeBlock
                    value={`${location.origin}/llms.txt`}
                    label="复制 AI 文档地址"
                  />
                </CardContent>
                <CardFooter className="flex flex-wrap gap-2">
                  <Button variant="outline" asChild>
                    <a
                      href="/llms-full.txt"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      完整 AI 参考
                      <ExternalLink data-icon="inline-end" />
                    </a>
                  </Button>
                </CardFooter>
              </Card>
              <Alert>
                <ShieldCheck />
                <AlertTitle>批次完成后，还要检查每一项</AlertTitle>
                <AlertDescription>
                  批量查收最多 5
                  个邮箱。只重试标记为可重试的失败项；空结果按建议间隔继续等待。登记和删除超时后先核对状态。
                </AlertDescription>
              </Alert>
              <Button variant="outline" asChild>
                <a href="/api-doc.md" target="_blank" rel="noopener noreferrer">
                  查看 Python 轮询示例
                  <Code2 data-icon="inline-end" />
                </a>
              </Button>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="diagnose">
          <MailboxDiagnostic
            onOpen={() => {
              const entry = entries.find(
                (e) => e.operationId === "inspectMailbox",
              );
              if (entry) open(entry);
            }}
          />
        </TabsContent>
      </Tabs>
      <Sheet
        open={!!selected}
        onOpenChange={(value) => {
          if (!value) setSelected(undefined);
        }}
      >
        <SheetContent
          className="api-detail-sheet"
          closeLabel="关闭接口详情"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            detailTitle.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current?.isConnected) opener.current.focus();
            else document.getElementById("main-content")?.focus();
          }}
        >
          {selected && spec && (
            <>
              <SheetHeader className="shrink-0 border-b pr-12">
                <SheetTitle ref={detailTitle} tabIndex={-1}>
                  {selected.summary}
                </SheetTitle>
                <SheetDescription className="break-all">
                  {selected.method} {selected.path}
                </SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
                <OperationDetail
                  key={selected.operationId}
                  entry={selected}
                  spec={spec}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function OperationDetail({ entry, spec }: { entry: Entry; spec: Spec }) {
  const [language, setLanguage] = useState("curl");
  const request = entry.requestBody?.content["application/json"];
  const requestSchema = request
    ? (expanded(request.schema, spec.components.schemas) as Schema)
    : undefined;
  const fields = (requestSchema?.properties || {}) as Record<string, Schema>;
  const response = Object.values(entry.responses["200"]?.content || {})[0];
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{authLabels[entry["x-auth-mode"]]}</Badge>
        <code className="break-all text-xs text-muted-foreground">
          {entry.operationId}
        </code>
        <CopyButton value={entry.operationId} label="复制 operationId" />
      </div>
      <p className="text-sm leading-7">{entry.description}</p>
      <Alert>
        <SearchCheck />
        <AlertTitle>调用后的变化</AlertTitle>
        <AlertDescription>
          {entry["x-side-effects"]}
          {entry["x-credential-response"] &&
            "。响应包含凭据，请避免记录或分享。"}
        </AlertDescription>
      </Alert>
      {!!entry.parameters.length && (
        <div>
          <h3 className="mb-2 font-medium">路径与查询参数</h3>
          <dl className="api-parameter-list">
            {entry.parameters.map((p) => (
              <div key={`${p.in}-${p.name}`}>
                <dt>
                  <code>{p.name}</code>
                  <Badge variant="outline">
                    {p.in}
                    {p.required ? " · 必填" : ""}
                  </Badge>
                </dt>
                <dd>
                  {p.description}
                  {Array.isArray(p.schema.enum) && (
                    <span className="mt-1 block break-all text-xs">
                      可选：{p.schema.enum.join(" / ")}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {!!Object.keys(fields).length && (
        <div>
          <h3 className="mb-2 font-medium">请求体字段</h3>
          <dl className="api-parameter-list">
            {Object.entries(fields).map(([name, field]) => (
              <div key={name}>
                <dt>
                  <code>{name}</code>
                  <Badge variant="outline">
                    {Array.isArray(field.type)
                      ? field.type.join(" / ")
                      : String(field.type || "object")}
                    {Array.isArray(requestSchema?.required) &&
                    requestSchema.required.includes(name)
                      ? " · 必填"
                      : ""}
                  </Badge>
                </dt>
                <dd>
                  {typeof field.description === "string"
                    ? field.description
                    : Array.isArray(field.enum)
                      ? `可选：${field.enum.join(" / ")}`
                      : field.type === "array"
                        ? `数组${field.maxItems ? `，最多 ${field.maxItems} 项` : ""}`
                        : field.maxLength
                          ? `最长 ${field.maxLength} 个字符`
                          : field.minimum !== undefined
                            ? `最小值 ${field.minimum}${field.maximum !== undefined ? `，最大值 ${field.maximum}` : ""}`
                            : "见请求示例与完整约束"}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div>
        <h3 className="mb-3 font-medium">请求示例</h3>
        <Tabs value={language} onValueChange={setLanguage}>
          <TabsList>
            <TabsTrigger value="curl">cURL</TabsTrigger>
            <TabsTrigger value="javascript">JavaScript</TabsTrigger>
            <TabsTrigger value="python">Python</TabsTrigger>
          </TabsList>
          {["curl", "javascript", "python"].map((lang) => (
            <TabsContent key={lang} value={lang}>
              <CodeBlock value={apiSnippet(entry, lang, location.origin)} />
            </TabsContent>
          ))}
        </Tabs>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          示例使用占位符。替换 ID、邮箱、时间和环境变量后在自己的环境中运行。
        </p>
      </div>
      {request && (
        <details className="api-schema">
          <summary>请求体字段与约束</summary>
          <CodeBlock
            value={JSON.stringify(
              expanded(request.schema, spec.components.schemas),
              null,
              2,
            )}
            label="复制请求 Schema"
          />
        </details>
      )}
      {response && (
        <div>
          <h3 className="mb-3 font-medium">成功响应</h3>
          {response.example !== undefined && (
            <CodeBlock
              value={JSON.stringify(response.example, null, 2)}
              label="复制响应示例"
            />
          )}
          <details className="api-schema mt-3">
            <summary>查看完整响应 Schema</summary>
            <CodeBlock
              value={JSON.stringify(
                expanded(response.schema, spec.components.schemas),
                null,
                2,
              )}
              label="复制响应 Schema"
            />
          </details>
        </div>
      )}
      <Separator />
      <p className="text-sm leading-6 text-muted-foreground">
        失败时读取 HTTP 状态与 error / message。自动化查收还会返回 retryable 和
        retry_after；问题反馈可附 X-Request-ID。
      </p>
      <Button variant="outline" asChild>
        <a href="/api-doc.md" target="_blank" rel="noopener noreferrer">
          完整错误与重试指南
          <ExternalLink data-icon="inline-end" />
        </a>
      </Button>
    </div>
  );
}

function MailboxDiagnostic({ onOpen }: { onOpen: () => void }) {
  const [email, setEmail] = useState("");
  const [source, setSource] = useState("");
  const [result, setResult] = useState<{
    email: string;
    source: string;
    health: MailboxHealth;
    live_check: false;
    mailbox: { is_expired: boolean } | null;
  }>();
  const action = useAction({ inline: true });
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>检查邮箱能否接入自动化</CardTitle>
          <CardDescription>
            使用当前登录会话查询已记录的接入状态；不会刷新微软授权或读取邮件。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id="api-diagnostic"
            onSubmit={(e) => {
              e.preventDefault();
              setResult(undefined);
              void action.run(async () => {
                const r = await api<typeof result>(
                  "/api/automation/mailbox",
                  "POST",
                  { email: email.trim(), ...(source ? { source } : {}) },
                );
                setResult(r.data);
              });
            }}
          >
            <FieldGroup>
              <TextField
                label="邮箱地址"
                type="email"
                required
                value={email}
                disabled={action.busy}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setResult(undefined);
                }}
                placeholder="user@outlook.com"
              />
              <SelectField
                label="邮箱来源"
                value={source}
                disabled={action.busy}
                onChange={(v) => {
                  setSource(v);
                  setResult(undefined);
                }}
                options={[
                  ["", "自动识别"],
                  ["outlook", "Outlook"],
                  ["cf_domain", "自建域名"],
                  ["mailtm", "Mail.tm"],
                  ["mailgw", "Mail.gw"],
                  ["mailslurp", "MailSlurp"],
                  ["mailinator", "Mailinator Private"],
                ]}
              />
              <ActionError message={action.error} />
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <BusyButton form="api-diagnostic" type="submit" busy={action.busy}>
            <SearchCheck data-icon="inline-start" />
            诊断接入状态
          </BusyButton>
          <Button variant="ghost" onClick={onOpen}>
            查看对应 API
            <ArrowRight data-icon="inline-end" />
          </Button>
        </CardFooter>
      </Card>
      {result ? (
        <Card aria-live="polite">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  result.health.needs_attention ? "destructive" : "secondary"
                }
              >
                {result.health.label}
              </Badge>
              <Badge variant="outline">{result.source}</Badge>
            </div>
            <CardTitle className="break-all">{result.email}</CardTitle>
            <CardDescription>{result.health.message}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="flex items-center gap-2 text-sm">
              {result.health.can_lookup ? (
                <Check className="size-4 text-muted-foreground" />
              ) : (
                <CircleAlert className="size-4 text-muted-foreground" />
              )}
              {result.health.can_lookup
                ? "支持查询验证内容"
                : result.health.state === "external"
                  ? "当前来源不支持自动查收"
                  : "完成接入或授权后再查收"}
            </p>
            {result.mailbox?.is_expired && (
              <Alert>
                <AlertTitle>邮箱已过期</AlertTitle>
                <AlertDescription>
                  仍可查询历史邮件；新邮件需要先延长邮箱有效期。
                </AlertDescription>
              </Alert>
            )}
            <p className="text-xs leading-6 text-muted-foreground">
              这是工作区保存的状态，不能代替当前微软连接或真实邮件投递检查。
            </p>
            <details className="api-schema">
              <summary>查看 JSON 结果</summary>
              <CodeBlock
                value={JSON.stringify(result, null, 2)}
                label="复制诊断结果"
              />
            </details>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>先确认来源，再开始查收</CardTitle>
            <CardDescription>
              当台账显示使用中，但邮箱无法收件时，这里可以帮助定位缺少的接入步骤。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="compact-steps">
              <li>确认 Outlook 邮箱已经进入账号池。</li>
              <li>查看是否停用、授权失效或待检查。</li>
              <li>自建邮箱同时检查域名和保留期限。</li>
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
