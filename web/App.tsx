import {
  ActionError,
  BusyButton,
  ErrorState,
  IconButton,
  Loading,
  Modal,
  ModalBody,
  TextField,
} from "@/components/common";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { FieldGroup } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import {
  api,
  clearSession,
  query,
  useAction,
  useDebounce,
  useResource,
} from "@/lib/api";
import {
  useWorkspace,
  WorkspaceContext,
  type OutlookRecoveryTarget,
} from "@/lib/context";
import { useTheme } from "@/lib/theme";
import type {
  Mail as MailType,
  Outlook,
  PageName,
  Settings,
  Vault,
} from "@/lib/types";
import {
  ArrowRight,
  ChevronRight,
  Code2,
  Database,
  Globe2,
  Inbox,
  Layers2,
  LockKeyhole,
  LogOut,
  Mail,
  Moon,
  PanelLeft,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Timer,
  SlidersHorizontal,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
const VaultPage = lazy(() => import("@/pages/vault"));
const IdentitiesPage = lazy(() => import("@/pages/identities"));
const IdentitySheet = lazy(() => import("@/features/mailbox-identity"));
const VaultEditor = lazy(() =>
  import("@/pages/vault").then((m) => ({ default: m.VaultEditor })),
);
const ProvidersPage = lazy(() => import("@/pages/providers"));
const OutlookPage = lazy(() => import("@/pages/outlook"));
const InboxPage = lazy(() => import("@/pages/mail"));
const MailRulesPage = lazy(() => import("@/features/mail-rules"));
const MailboxesPage = lazy(() =>
  import("@/pages/mail").then((m) => ({ default: m.MailboxesPage })),
);
const DomainsPage = lazy(() => import("@/pages/domains"));
const StoragePage = lazy(() => import("@/pages/storage"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const ApiPage = lazy(() => import("@/pages/api"));
const OutlookReader = lazy(() =>
  import("@/features/readers").then((m) => ({ default: m.OutlookReader })),
);
const OutlookRecoveryDialog = lazy(() =>
  import("@/features/outlook-recovery").then((m) => ({
    default: m.OutlookRecoveryDialog,
  })),
);
const CfReader = lazy(() =>
  import("@/features/readers").then((m) => ({ default: m.CfReader })),
);
const CodeReader = lazy(() =>
  import("@/features/readers").then((m) => ({ default: m.CodeReader })),
);
const navigation = [
  { id: "vault", label: "平台账号", icon: Layers2 },
  { id: "identities", label: "邮箱资产", icon: Mail },
  { id: "outlook", label: "Outlook", icon: Mail },
  { id: "providers", label: "外部邮箱", icon: Globe2 },
  { id: "mailboxes", label: "临时邮箱", icon: Timer },
  { id: "inbox", label: "域名收件箱", icon: Inbox },
  { id: "rules", label: "收件规则", icon: SlidersHorizontal },
  { id: "domains", label: "域名管理", icon: Globe2 },
  { id: "api", label: "API 接入", icon: Code2 },
  { id: "storage", label: "数据源", icon: Database },
  { id: "settings", label: "设置", icon: SettingsIcon },
] as const;
function currentPage() {
  const [id, params] = location.hash.slice(1).split("?");
  return {
    page: (navigation.some((n) => n.id === id) ? id : "vault") as PageName,
    query: new URLSearchParams(params).get("q") || "",
  };
}
export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const expire = useCallback(() => {
    clearSession();
    setAuthenticated(false);
  }, []);
  const check = useCallback(() => {
    setError("");
    void api("/api/auth/me")
      .then((r) =>
        setAuthenticated(
          (r as unknown as { authenticated: boolean }).authenticated,
        ),
      )
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    check();
    window.addEventListener("mailhub:unauthorized", expire);
    return () => window.removeEventListener("mailhub:unauthorized", expire);
  }, [check, expire]);
  const logout = async () => {
    await api("/api/auth/logout", "POST");
    expire();
  };
  return (
    <>
      {authenticated ? (
        <Workspace logout={logout} />
      ) : authenticated === null ? (
        <div className="boot-screen">
          <Brand />
          {error ? <ErrorState message={error} retry={check} /> : <Loading />}
        </div>
      ) : (
        <Login onLogin={() => setAuthenticated(true)} />
      )}
      <Toaster position="top-right" visibleToasts={1} richColors closeButton />
    </>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Mail />
      </span>
      <span>
        MailHub<span className="brand-sub">邮箱与账号工作区</span>
      </span>
    </div>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const action = useAction();
  return (
    <div className="login-page">
      <section className="login-story">
        <Brand />
        <div>
          <div className="mail-art" aria-hidden="true">
            <div className="art-line" />
            <div className="art-envelope">
              <Mail />
            </div>
            <span className="art-tag">
              <Globe2 />
              自建域名
            </span>
            <span className="art-tag second">
              <ShieldCheck />
              账号与凭据
            </span>
            <span className="art-tag third">
              <Inbox />
              Outlook
            </span>
          </div>
          <h1>
            所有邮箱，
            <br />
            一个清晰的工作区。
          </h1>
          <p>
            连接 Outlook，管理多个域名，
            <br />
            让收件地址与平台账号井然有序。
          </p>
        </div>
        <span className="login-foot">MailHub & Vault</span>
      </section>
      <main id="main-content" tabIndex={-1} className="login-form-panel">
        <div className="w-full max-w-sm">
          <div className="mb-12 lg:hidden">
            <Brand />
          </div>
          <div className="mb-8">
            <span className="login-lock">
              <LockKeyhole />
            </span>
            <h2 className="mt-5 text-2xl font-semibold">登录工作区</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              输入管理员密码，继续管理你的邮箱与账号。
            </p>
          </div>
          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                await api("/api/auth/login", "POST", { password });
                setPassword("");
                onLogin();
              });
            }}
          >
            <FieldGroup>
              <TextField
                label="管理员"
                name="username"
                autoComplete="username"
                value="admin"
                readOnly
              />
              <TextField
                label="密码"
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入管理员密码"
              />
            </FieldGroup>
            <BusyButton type="submit" busy={action.busy}>
              进入工作区
              <ArrowRight data-icon="inline-end" />
            </BusyButton>
          </form>
          <p className="mt-8 flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4" />
            仅限管理员访问
          </p>
        </div>
      </main>
    </div>
  );
}
type Confirmation = {
  title: string;
  description: string;
  action: () => Promise<unknown>;
};
function Workspace({ logout }: { logout: () => Promise<void> }) {
  const [route, setRoute] = useState(currentPage);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const settings = useResource<Settings>("/api/settings", revision);
  const [vault, setVault] = useState<{
    draft: Partial<Vault>;
    section?: "verification";
  } | null>(null);
  const [identity, setIdentity] = useState<{
    address: string;
    source: string;
    opener: HTMLElement | null;
  } | null>(null);
  const [outlook, setOutlook] = useState<{ id: number; email: string } | null>(
    null,
  );
  const [outlookRecovery, setOutlookRecovery] =
    useState<OutlookRecoveryTarget | null>(null);
  const [mail, setMail] = useState<number | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [search, setSearch] = useState(false);
  const navigate = useCallback(
    (page: PageName, q = "") => {
      if (outlookRecovery) {
        // Settings opened from a repair must be reachable behind its readers.
        setOutlook(null);
        setCode(null);
        setMail(null);
        setVault(null);
        setIdentity(null);
      }
      location.hash = page + (q ? `?${query({ q })}` : "");
    },
    [outlookRecovery],
  );
  useEffect(() => {
    const onHash = () => setRoute(currentPage());
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((s) => !s);
      }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const value = {
    settings: settings.result?.data,
    revision,
    refresh,
    navigate,
    vault: (draft: Partial<Vault>, section?: "verification") =>
      setVault({ draft, section }),
    identity: (target: { address: string; source: string }) =>
      setIdentity({
        ...target,
        opener:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
      }),
    outlook: (id: number, email: string) => setOutlook({ id, email }),
    repairOutlook: (target: OutlookRecoveryTarget) =>
      setOutlookRecovery((current) => current ?? { ...target }),
    mail: setMail,
    code: setCode,
    confirm: (
      title: string,
      description: string,
      action: () => Promise<unknown>,
    ) => setConfirmation({ title, description, action }),
  };
  return (
    <WorkspaceContext.Provider value={value}>
      <SidebarProvider
        style={{ "--sidebar-width": "14.5rem" } as CSSProperties}
      >
        <Navigation page={route.page} logout={logout} />
        <div className="workspace">
          <Topbar page={route.page} search={() => setSearch(true)} />
          <main id="main-content" tabIndex={-1} className="workspace-content">
            {settings.error && (
              <div className="mb-5">
                <ErrorState message={settings.error} retry={settings.reload} />
              </div>
            )}
            <Suspense fallback={<Loading />}>
              {route.page === "vault" && (
                <VaultPage key={route.query} initialQuery={route.query} />
              )}
              {route.page === "identities" && (
                <IdentitiesPage key={route.query} initialQuery={route.query} />
              )}
              {route.page === "outlook" && (
                <OutlookPage key={route.query} initialQuery={route.query} />
              )}
              {route.page === "providers" && (
                <ProvidersPage key={route.query} initialQuery={route.query} />
              )}
              {route.page === "mailboxes" && <MailboxesPage />}
              {route.page === "inbox" && (
                <InboxPage key={route.query} initialQuery={route.query} />
              )}
              {route.page === "rules" && <MailRulesPage />}
              {route.page === "domains" && <DomainsPage />}
              {route.page === "settings" && <SettingsPage />}
              {route.page === "storage" && <StoragePage />}
              {route.page === "api" && <ApiPage />}
            </Suspense>
          </main>
        </div>
      </SidebarProvider>
      {identity && (
        <Suspense fallback={null}>
          <IdentitySheet
            key={`${identity.source}:${identity.address}`}
            target={identity}
            close={() => setIdentity(null)}
          />
        </Suspense>
      )}
      {vault && (
        <Suspense fallback={null}>
          <VaultEditor
            key={vault.draft.id ?? "new"}
            {...vault}
            close={() => setVault(null)}
          />
        </Suspense>
      )}
      {outlook && (
        <Suspense fallback={null}>
          <OutlookReader {...outlook} close={() => setOutlook(null)} />
        </Suspense>
      )}
      {mail !== null && (
        <Suspense fallback={null}>
          <CfReader
            id={mail}
            close={() => {
              setMail(null);
              refresh();
            }}
          />
        </Suspense>
      )}
      {code && (
        <Suspense fallback={null}>
          <CodeReader key={code} path={code} close={() => setCode(null)} />
        </Suspense>
      )}
      {outlookRecovery && (
        <Suspense fallback={null}>
          <OutlookRecoveryDialog
            target={outlookRecovery}
            close={() => setOutlookRecovery(null)}
          />
        </Suspense>
      )}
      {search && <GlobalSearch close={() => setSearch(false)} />}
      {confirmation && (
        <ConfirmationDialog
          {...confirmation}
          close={() => setConfirmation(null)}
        />
      )}
    </WorkspaceContext.Provider>
  );
}
function Navigation({
  page,
  logout,
}: {
  page: PageName;
  logout: () => Promise<void>;
}) {
  const sidebar = useSidebar();
  const action = useAction();
  return (
    <Sidebar>
      <SidebarHeader className="px-5 py-7">
        <Brand />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>工作区</SidebarGroupLabel>
          <SidebarMenu>
            {navigation.slice(0, 8).map(({ id, label, icon: Icon }) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuButton asChild isActive={id === page}>
                  <a
                    href={`#${id}`}
                    onClick={() => sidebar.setOpenMobile(false)}
                    aria-current={id === page ? "page" : undefined}
                  >
                    <Icon />
                    <span>{label}</span>
                    {id === page && <ChevronRight className="ml-auto" />}
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="mt-auto">
          <SidebarGroupLabel>管理</SidebarGroupLabel>
          <SidebarMenu>
            {navigation.slice(8).map(({ id, label, icon: Icon }) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuButton asChild isActive={id === page}>
                  <a
                    href={`#${id}`}
                    onClick={() => sidebar.setOpenMobile(false)}
                    aria-current={id === page ? "page" : undefined}
                  >
                    <Icon />
                    <span>{label}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-4 p-4">
        <Separator />
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>A</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <p className="text-sm font-medium">管理员</p>
            <p className="text-xs text-muted-foreground">个人工作区</p>
          </div>
          <IconButton
            label="退出登录"
            disabled={action.busy}
            onClick={() => {
              void action.run(logout);
            }}
          >
            <LogOut />
          </IconButton>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
function Topbar({ page, search }: { page: PageName; search: () => void }) {
  const { resolved, setTheme } = useTheme();
  const sidebar = useSidebar();
  return (
    <header className="topbar">
      <div className="flex min-w-0 items-center gap-2">
        <IconButton label="切换导航" onClick={sidebar.toggleSidebar}>
          <PanelLeft />
        </IconButton>
        <Separator orientation="vertical" className="mx-2 h-4" />
        <span className="hidden text-sm text-muted-foreground sm:inline">
          工作区
        </span>
        <ChevronRight className="hidden size-3 text-muted-foreground sm:inline" />
        <span className="whitespace-nowrap text-sm font-medium">
          {navigation.find((n) => n.id === page)?.label}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          className="global-search-trigger"
          aria-label="搜索工作区"
          onClick={search}
        >
          <Search data-icon="inline-start" />
          <span>搜索工作区</span>
          <kbd>⌘ K</kbd>
        </Button>
        <IconButton
          label={resolved === "dark" ? "切换浅色主题" : "切换深色主题"}
          onClick={() => setTheme(resolved === "dark" ? "light" : "dark")}
        >
          {resolved === "dark" ? <Sun /> : <Moon />}
        </IconButton>
      </div>
    </header>
  );
}
function ConfirmationDialog({
  title,
  description,
  action,
  close,
}: Confirmation & { close: () => void }) {
  const run = useAction({ inline: true });
  return (
    <AlertDialog open onOpenChange={(v) => !v && !run.busy && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          <ActionError message={run.error} />
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={run.busy}>取消</AlertDialogCancel>
          <BusyButton
            variant="destructive"
            busy={run.busy}
            onClick={() => {
              void run.run(async () => {
                await action();
                close();
              });
            }}
          >
            确认操作
          </BusyButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
function GlobalSearch({ close }: { close: () => void }) {
  const w = useWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const search = useDebounce(q);
  const r = useResource<{
    vault: Vault[];
    outlook: Outlook[];
    mails: MailType[];
  }>(search.trim() ? `/api/search?${query({ q: search })}` : null);
  const choose = (fn: () => void) => {
    close();
    fn();
  };
  return (
    <Modal
      title="搜索工作区"
      description="搜索全部平台账号、Outlook 邮箱和域名邮件。"
      close={close}
      wide
    >
      <ModalBody className="gap-0 overflow-hidden p-2 *:shrink sm:p-2">
        <Command shouldFilter={false} className="h-auto min-h-0 flex-1">
          <CommandInput
            ref={input}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            name="workspace-search"
            placeholder="输入平台、邮箱或邮件关键词…"
            value={q}
            onValueChange={setQ}
          />
          <CommandList className="min-h-0 flex-1">
            {r.loading ? (
              <div className="p-4 text-sm text-muted-foreground">正在搜索…</div>
            ) : r.error ? (
              <div className="p-2">
                <ErrorState
                  message={r.error}
                  retry={() => {
                    r.reload();
                    input.current?.focus();
                  }}
                />
              </div>
            ) : (
              <>
                <CommandEmpty>
                  {q ? "没有匹配的记录" : "输入关键词开始搜索"}
                </CommandEmpty>
                {!!r.result?.data.vault.length && (
                  <CommandGroup heading="平台账号">
                    {r.result.data.vault.map((a) => (
                      <CommandItem
                        key={a.id}
                        value={`vault-${a.id}`}
                        onSelect={() => choose(() => w.vault(a))}
                      >
                        <Layers2 />
                        <div className="min-w-0">
                          <p>{a.platform_name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {a.account_email}
                          </p>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {!!r.result?.data.outlook.length && (
                  <CommandGroup heading="Outlook">
                    {r.result.data.outlook.map((a) => (
                      <CommandItem
                        key={a.id}
                        value={`outlook-${a.id}`}
                        onSelect={() => choose(() => w.outlook(a.id, a.email))}
                      >
                        <Mail />
                        <span className="min-w-0 truncate">{a.email}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {!!r.result?.data.mails.length && (
                  <CommandGroup heading="域名邮件">
                    {r.result.data.mails.map((m) => (
                      <CommandItem
                        key={m.id}
                        value={`mail-${m.id}`}
                        onSelect={() => choose(() => w.mail(Number(m.id)))}
                      >
                        <Inbox />
                        <span className="truncate">
                          {m.subject || "(无主题)"}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </ModalBody>
    </Modal>
  );
}
