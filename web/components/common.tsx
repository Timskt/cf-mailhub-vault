import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { copy } from "@/lib/api";
import type { Reply } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Copy,
  Inbox,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

export {
  DialogBody as ModalBody,
  DialogFooter as ModalFooter,
} from "@/components/ui/dialog";

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = "搜索…",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <InputGroup className="search-box">
      <InputGroupInput
        type="search"
        id={id}
        name={`filter-${id}`}
        value={composing ? draft : value}
        aria-label={placeholder}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        onCompositionStart={() => {
          setDraft(value);
          setComposing(true);
        }}
        onCompositionEnd={(e) => {
          setComposing(false);
          onChange(e.currentTarget.value);
        }}
        onChange={(e) =>
          composing ? setDraft(e.target.value) : onChange(e.target.value)
        }
      />
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label="清空搜索" onClick={() => onChange("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
export function Pick({
  value,
  onChange,
  options,
  label,
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: (readonly [string, string])[];
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value || "__all"}
      onValueChange={(v) => onChange(v === "__all" ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} className={cn("min-w-32", className)}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map(([key, text]) => (
            <SelectItem value={key || "__all"} key={key}>
              {text}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
export function TextField({
  label,
  help,
  ...props
}: ComponentProps<typeof Input> & { label: string; help?: string }) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input {...props} id={id} autoComplete={props.autoComplete || "off"} />
      {help && <FieldDescription>{help}</FieldDescription>}
    </Field>
  );
}
export function SelectField({ label, ...props }: ComponentProps<typeof Pick>) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Pick label={label} {...props} className="w-full" />
    </Field>
  );
}
export function BusyButton({
  busy,
  children,
  ...props
}: ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button {...props} disabled={busy || props.disabled}>
      {busy && (
        <LoaderCircle className="animate-spin" data-icon="inline-start" />
      )}
      {children}
    </Button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
export function CopyButton({
  value,
  label = "复制",
}: {
  value?: string;
  label?: string;
}) {
  const feedback = useCopyFeedback(value);
  return (
    <IconButton
      label={feedback.status || label}
      aria-label={label}
      onClick={feedback.copy}
    >
      {feedback.status === "已复制" ? (
        <Check />
      ) : feedback.status ? (
        <CircleAlert className="text-destructive" />
      ) : (
        <Copy />
      )}
      <span className="sr-only" role="status">
        {feedback.status}
      </span>
    </IconButton>
  );
}
function useCopyFeedback(value?: string) {
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  return {
    status,
    copy: async () => {
      setStatus(
        (await copy(value, "内容", false)) ? "已复制" : "复制失败，请手动复制",
      );
    },
  };
}
export function CopyAction({
  value,
  label,
  ...props
}: ComponentProps<typeof Button> & { value?: string; label: string }) {
  const feedback = useCopyFeedback(value);
  return (
    <Button type="button" {...props} aria-label={label} onClick={feedback.copy}>
      {feedback.status === "已复制" ? (
        <Check data-icon="inline-start" />
      ) : (
        <Copy data-icon="inline-start" />
      )}
      <span role="status">{feedback.status || label}</span>
    </Button>
  );
}
export function Menu({
  items,
  label = "更多操作",
  trigger,
}: {
  label?: string;
  trigger?: ReactNode;
  items: {
    label: string;
    icon?: ReactNode;
    action: () => void;
    danger?: boolean;
    disabled?: boolean;
  }[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="icon" aria-label={label}>
            <MoreHorizontal />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {items.map((item) => (
            <DropdownMenuItem
              key={item.label}
              variant={item.danger ? "destructive" : "default"}
              disabled={item.disabled}
              onSelect={item.action}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
/** Compose content with ModalBody and ModalFooter; forms use .modal-form. */
export function Modal({
  title,
  description,
  children,
  close,
  wide = false,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
  className?: string;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className={cn(wide && "max-w-3xl", className)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description || "填写下方信息后保存。"}
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function Blank({
  title = "暂无记录",
  description = "试试调整筛选条件，或添加第一条记录。",
  children,
}: {
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
export function Loading() {
  return (
    <div
      className="flex flex-col gap-4 py-6"
      aria-label="正在加载"
      role="status"
    >
      {[1, 2, 3].map((n) => (
        <Skeleton key={n} className="h-16 w-full" />
      ))}
    </div>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <Alert variant="destructive" className="p-4">
      <CircleAlert />
      <AlertTitle>暂时无法加载</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3 text-pretty">
        <div className="w-full [overflow-wrap:anywhere]">{message}</div>
        {retry && (
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <RefreshCw data-icon="inline-start" />
            重新加载
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
export function ActionError({ message }: { message?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.scrollIntoView({ block: "nearest" });
  }, [message]);
  if (!message) return null;
  return (
    <Alert ref={ref} variant="destructive" className="p-4">
      <CircleAlert />
      <AlertTitle>操作未完成</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
export function Pager({
  result,
  page,
  setPage,
}: {
  result?: PickReply;
  page: number;
  setPage: (p: number) => void;
}) {
  const pages = Math.max(
    1,
    Math.ceil((result?.total || 0) / (result?.limit || 30)),
  );
  useEffect(() => {
    if (result && !result.has_more && page > pages) setPage(pages);
  }, [result, page, pages, setPage]);
  if (!result) return null;
  return (
    <div className="pager">
      <span>
        {result.has_more
          ? `至少 ${result.total || 0} 条记录`
          : `共 ${result.total || 0} 条记录`}
      </span>
      <div className="flex items-center gap-3">
        <span>
          {page} / {pages}
          {result.has_more ? "+" : ""}
        </span>
        <IconButton
          label="上一页"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ArrowLeft />
        </IconButton>
        <IconButton
          label="下一页"
          disabled={
            result.has_more === undefined ? page >= pages : !result.has_more
          }
          onClick={() => setPage(page + 1)}
        >
          <ArrowRight />
        </IconButton>
      </div>
    </div>
  );
}
type PickReply = Pick<Reply<unknown>, "total" | "limit" | "has_more">;
export function RefreshButton({
  onClick,
  busy,
}: {
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <IconButton label="刷新" onClick={onClick} disabled={busy}>
      <RefreshCw className={cn(busy && "animate-spin")} />
    </IconButton>
  );
}
export const statusNames: Record<string, string> = {
  healthy: "连接正常",
  unchecked: "待检查",
  reauth_required: "需重新授权",
  error: "连接异常",
  active: "正常",
  pending: "待验证",
  banned: "已封禁",
  deprecated: "已废弃",
  disabled: "已停用",
  ready: "DNS 已就绪",
  incomplete: "DNS 待完善",
  unknown: "DNS 待检查",
};
export function Status({ value }: { value: string }) {
  return (
    <Badge
      variant={
        ["error", "reauth_required", "banned"].includes(value)
          ? "destructive"
          : "outline"
      }
    >
      <span
        className={cn(
          "status-dot",
          ["healthy", "active", "ready"].includes(value) && "status-good",
          ["pending", "unchecked", "incomplete"].includes(value) &&
            "status-wait",
        )}
      />
      {statusNames[value] || value}
    </Badge>
  );
}
