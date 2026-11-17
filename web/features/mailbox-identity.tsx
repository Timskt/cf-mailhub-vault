import { useRef, useState } from "react";
import { KeyRound, Pencil, Plus, ShieldCheck } from "lucide-react";
import {
  Blank,
  CopyButton,
  ErrorState,
  Loading,
  Pager,
  Pick,
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { date, query, useResource } from "@/lib/api";
import { useWorkspace } from "@/lib/context";
import { identityPath, loginMethodLabel, sourceName } from "@/lib/identities";
import type { MailboxIdentity, Vault } from "@/lib/types";

export default function IdentitySheet({
  target,
  close,
}: {
  target: { address: string; source: string; opener: HTMLElement | null };
  close: () => void;
}) {
  const w = useWorkspace();
  const path = identityPath(target);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [tab, setTab] = useState("registrations");
  const title = useRef<HTMLHeadingElement>(null);
  const identity = useResource<MailboxIdentity>(path, w.revision);
  const rows = useResource<Vault[]>(
    `${path}/registrations?${query({ page, limit })}`,
    w.revision,
  );
  const impact = useResource<{
    identity: MailboxIdentity;
    registrations: number;
    protected: boolean;
  }>(tab === "connection" ? `${path}/impact` : null, w.revision);
  const data = identity.result?.data;
  const health = data?.health;
  const add = () =>
    w.vault({ account_email: target.address, email_source: target.source });
  const manage = () => {
    if (target.source === "outlook")
      w.repairOutlook({
        id: data?.account_id ?? undefined,
        email: target.address,
      });
    else {
      close();
      w.navigate(
        target.source === "cf_domain" ? "domains" : "providers",
        target.source === "cf_domain" ? "" : target.address,
      );
    }
  };
  return (
    <Sheet open onOpenChange={(open) => !open && close()}>
      <SheetContent
        closeLabel="关闭邮箱详情"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (
            target.opener?.isConnected &&
            !target.opener.closest('[inert], [aria-hidden="true"]')
          )
            target.opener.focus({ preventScroll: true });
          else
            document
              .getElementById("main-content")
              ?.focus({ preventScroll: true });
        }}
      >
        <SheetHeader className="shrink-0 gap-2 border-b p-5 pr-14">
          <SheetTitle ref={title} tabIndex={-1} className="break-all">
            {target.address} · 邮箱资产
          </SheetTitle>
          <SheetDescription>来源：{sourceName(target.source)}</SheetDescription>
          <div className="flex flex-wrap items-center gap-2">
            {health && (
              <Badge
                variant={health.needs_attention ? "destructive" : "secondary"}
              >
                {health.label}
              </Badge>
            )}
            <CopyButton value={target.address} label="复制邮箱地址" />
          </div>
          <p className="text-xs text-muted-foreground">
            {health?.message || "正在读取邮箱连接状态…"}
          </p>
        </SheetHeader>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4 sm:p-5">
          {identity.error && (
            <ErrorState message={identity.error} retry={identity.reload} />
          )}
          <Tabs value={tab} onValueChange={setTab} className="min-w-0 gap-4">
            <TabsList aria-label="邮箱详情视角">
              <TabsTrigger value="registrations">平台注册</TabsTrigger>
              <TabsTrigger value="connection">连接概览</TabsTrigger>
            </TabsList>
            <TabsContent
              value="registrations"
              className="flex min-w-0 flex-col gap-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p role="status" className="text-sm">
                  {rows.result
                    ? `${rows.result.summary?.platforms ?? data?.platform_count ?? 0} 个平台 · ${rows.result.summary?.registrations ?? rows.result.total ?? 0} 条登记`
                    : "正在加载登记…"}
                </p>
                <Pick
                  label="登记每页数量"
                  value={String(limit)}
                  onChange={(value) => {
                    setLimit(Number(value));
                    setPage(1);
                  }}
                  options={[
                    ["10", "每页 10 条"],
                    ["20", "每页 20 条"],
                    ["50", "每页 50 条"],
                  ]}
                />
              </div>
              {rows.error ? (
                <ErrorState message={rows.error} retry={rows.reload} />
              ) : !rows.result ? (
                <Loading />
              ) : !rows.result.data.length ? (
                <Blank
                  title="尚无平台注册"
                  description="使用此邮箱登记新平台，每个平台的密码与 2FA 独立保存。"
                >
                  <Button onClick={add}>登记第一个平台</Button>
                </Blank>
              ) : (
                rows.result.data.map((account) => (
                  <article
                    key={account.id}
                    aria-label={`${account.platform_name} 登记`}
                  >
                    <Card size="sm" className="min-w-0">
                      <CardHeader>
                        <CardTitle className="break-all">
                          {account.platform_name}
                        </CardTitle>
                        <CardDescription className="break-all">
                          {account.account_identifier ||
                            account.username ||
                            account.account_email}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-2">
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="outline">
                            {loginMethodLabel(account.login_methods)}
                          </Badge>
                          <Badge
                            variant={
                              account.status === "banned"
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {(
                              {
                                active: "使用中",
                                pending: "待验证",
                                banned: "已封禁",
                                deprecated: "已废弃",
                              } as Record<string, string>
                            )[account.status] || account.status}
                          </Badge>
                          {account.mailbox_link_state === "detached" && (
                            <Badge variant="outline">已解除收件连接</Badge>
                          )}
                        </div>
                        <p className="text-sm break-all">
                          登录邮箱：{account.account_email}
                        </p>
                        {account.mailbox_address && (
                          <p className="text-xs break-all text-muted-foreground">
                            实际收件：{account.mailbox_address}
                          </p>
                        )}
                        {account.workspace && (
                          <p className="text-sm break-all">
                            工作区：{account.workspace}
                          </p>
                        )}
                        {account.expires_at && (
                          <p className="text-sm">
                            到期：{date(account.expires_at)}
                          </p>
                        )}
                        {account.last_verified_at && (
                          <p className="text-xs text-muted-foreground">
                            上次验证：{date(account.last_verified_at)}
                          </p>
                        )}
                        {account.remark && (
                          <p className="text-xs break-all text-muted-foreground">
                            {account.remark}
                          </p>
                        )}
                      </CardContent>
                      <CardFooter className="flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => w.vault(account)}
                        >
                          <Pencil data-icon="inline-start" />
                          编辑登记
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={
                            !account.mailbox?.can_lookup ||
                            account.mailbox_link_state === "detached"
                          }
                          onClick={() =>
                            w.code(
                              `/api/vault/${account.id}/code?match=platform`,
                            )
                          }
                        >
                          <KeyRound data-icon="inline-start" />
                          取码 / 链接
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => w.vault(account, "verification")}
                        >
                          配置取码规则
                        </Button>
                      </CardFooter>
                    </Card>
                  </article>
                ))
              )}
              <Pager
                result={rows.loading ? undefined : rows.result}
                page={page}
                setPage={setPage}
              />
            </TabsContent>
            <TabsContent
              value="connection"
              className="flex min-w-0 flex-col gap-4"
            >
              <Card>
                <CardHeader>
                  <CardTitle>邮箱连接状态</CardTitle>
                  <CardDescription>
                    此连接供多个平台注册使用，停用连接后仍可查看和编辑登记。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p>来源：{sourceName(target.source)}</p>
                  <p className="break-all">收件地址：{target.address}</p>
                  <p>
                    {health?.label} · {health?.message}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    最近检查：{date(health?.checked_at)}
                  </p>
                  {data?.expires_at && <p>邮箱到期：{date(data.expires_at)}</p>}
                  {impact.error ? (
                    <ErrorState message={impact.error} retry={impact.reload} />
                  ) : !impact.result ? (
                    <Loading />
                  ) : (
                    <Alert>
                      <ShieldCheck />
                      <AlertTitle>
                        {impact.result.data.protected
                          ? "邮箱受登记保护"
                          : "登记影响范围"}
                      </AlertTitle>
                      <AlertDescription>
                        此邮箱共有 {impact.result.data.registrations}{" "}
                        条登记。解除某条登记的收件连接会保留该平台的密码、2FA
                        与账号资料。
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
                {health?.action && (
                  <CardFooter>
                    <Button variant="outline" onClick={manage}>
                      {target.source === "outlook"
                        ? "授权与修复连接"
                        : "管理邮箱连接"}
                    </Button>
                  </CardFooter>
                )}
              </Card>
            </TabsContent>
          </Tabs>
        </div>
        <SheetFooter className="shrink-0 border-t">
          <Button onClick={add}>
            <Plus data-icon="inline-start" />
            登记新平台
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
