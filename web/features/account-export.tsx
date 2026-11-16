import {
  ActionError,
  BusyButton,
  ErrorState,
  Modal,
  ModalBody,
  ModalFooter,
  SelectField,
} from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { api, copy } from "@/lib/api";
import { Copy, Download, FileText, ShieldAlert } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  accountTextColumns,
  accountTextTemplate,
  hasSpreadsheetFormula,
  serializeAccountText,
  type AccountTextKind,
} from "../../shared/account-text";

export interface AccountExportDialogProps {
  kind: "vault" | "outlook";
  endpoint: string;
  title?: string;
  description?: string;
  close: () => void;
}

type ExportFormat = "text" | "csv" | "json";
type AccountRecord = Record<string, unknown>;
type ExportDocument = Record<string, unknown> & { accounts: AccountRecord[] };
const MAX_EXPORT_ACCOUNTS = 10000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readExportDocument(value: unknown): ExportDocument {
  if (!isRecord(value)) throw new Error("导出接口返回格式无效，请重试");
  const accounts = value.accounts ?? value.data;
  if (!Array.isArray(accounts))
    throw new Error("导出接口未返回账号列表，请重试");
  if (accounts.length > MAX_EXPORT_ACCOUNTS)
    throw new Error("单次最多导出 10,000 个账号，请缩小选择范围后重试");
  if (accounts.some((account) => !isRecord(account)))
    throw new Error("导出账号格式无效，请重试");
  if (typeof value.total === "number" && value.total > accounts.length)
    throw new Error("导出结果不完整，请使用完整导出接口或缩小选择范围");

  // Both export endpoints and selected-account endpoints are supported. Keep
  // every returned account field in JSON, with the reimportable accounts key.
  if (Array.isArray(value.accounts)) return value as ExportDocument;
  const { data: _data, ...metadata } = value;
  return { ...metadata, accounts: accounts as AccountRecord[] };
}

function downloadExport(
  content: string,
  format: ExportFormat,
  kind: AccountTextKind,
) {
  const extension = format === "text" ? "txt" : format;
  const mime =
    format === "json"
      ? "application/json"
      : format === "csv"
        ? "text/csv"
        : "text/plain";
  // A BOM helps spreadsheet importers identify Chinese UTF-8 CSV data. The
  // shared parser accepts it. Credential values themselves are never changed.
  const blob = new Blob([format === "csv" ? "\uFEFF" : "", content], {
    type: `${mime};charset=utf-8`,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `mailhub-${kind}-${new Date().toISOString().slice(0, 10)}.${extension}`;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Opening displays the format rules; credentials load only on Generate. */
export function AccountExportDialog(props: AccountExportDialogProps) {
  // Changing the export scope must discard the previous scope's credentials.
  return (
    <AccountExportContent key={`${props.kind}:${props.endpoint}`} {...props} />
  );
}

function AccountExportContent({
  kind,
  endpoint,
  title,
  description,
  close,
}: AccountExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("text");
  const [includeRemark, setIncludeRemark] = useState(false);
  const [exported, setExported] = useState<ExportDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const request = useRef<AbortController | null>(null);
  const id = useId();

  useEffect(() => () => request.current?.abort(), []);

  const load = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setFeedback("");
    setExported(null);
    try {
      const response = await api(endpoint, "GET", undefined, controller.signal);
      if (!controller.signal.aborted) setExported(readExportDocument(response));
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error ? failure.message : "导出失败，请重试",
        );
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const dismiss = () => {
    request.current?.abort();
    setExported(null);
    close();
  };
  const columns = accountTextColumns(kind, includeRemark);
  const template = useMemo(() => {
    if (format !== "json")
      return accountTextTemplate(kind, { format, includeRemark });
    return JSON.stringify(
      {
        version: 1,
        accounts: [
          Object.fromEntries(
            accountTextColumns(kind, true).map(({ key, example }) => [
              key,
              example,
            ]),
          ),
        ],
      },
      null,
      2,
    );
  }, [kind, format, includeRemark]);
  const generated = useMemo(() => {
    if (!exported) return { text: "", error: "", formulas: 0 };
    try {
      const text =
        format === "json"
          ? JSON.stringify(exported, null, 2)
          : serializeAccountText(exported.accounts, kind, {
              format,
              includeRemark,
            });
      const formulas =
        format === "csv"
          ? exported.accounts.reduce(
              (count, account) =>
                count +
                accountTextColumns(kind, includeRemark).filter(
                  ({ key }) =>
                    typeof account[key] === "string" &&
                    hasSpreadsheetFormula(account[key]),
                ).length,
              0,
            )
          : 0;
      return { text, error: "", formulas };
    } catch {
      return {
        text: "",
        error: "部分账号字段无法转换为文本，请切换到 JSON 格式以保留完整数据。",
        formulas: 0,
      };
    }
  }, [exported, format, kind, includeRemark]);
  const copyValue = async (value: string, label: string) => {
    const copied = await copy(value, label, false);
    setFeedback(copied ? `${label}已复制` : "剪贴板不可用，请选择文本手动复制");
  };
  const ready = !!exported?.accounts.length && !!generated.text && !busy;

  return (
    <Modal
      close={dismiss}
      title={
        title || `导出${kind === "outlook" ? " Outlook 账号" : "平台账号"}`
      }
      description={
        description || "选择格式后生成预览，可直接复制，也可下载文件。"
      }
      wide
    >
      <ModalBody>
        <Alert>
          <ShieldAlert />
          <AlertTitle>导出内容包含登录凭据</AlertTitle>
          <AlertDescription>
            密码、刷新令牌和 TOTP 密钥会以明文显示和导出，请妥善保管。
            点击“生成导出内容”后才会读取账号数据，关闭弹窗后清除本次预览。
          </AlertDescription>
        </Alert>
        <FieldGroup>
          <SelectField
            label="导出格式"
            value={format}
            onChange={(value) => {
              setFormat(value as ExportFormat);
              setFeedback("");
            }}
            options={[
              ["text", "固定格式文本（---- 分隔）"],
              ["csv", "CSV（带字段表头）"],
              ["json", "JSON（保留接口返回的全部字段）"],
            ]}
          />
          {kind === "outlook" && format !== "json" && (
            <Field orientation="horizontal">
              <Checkbox
                id={`${id}-remark`}
                checked={includeRemark}
                onCheckedChange={(value) => {
                  setIncludeRemark(value === true);
                  setFeedback("");
                }}
              />
              <FieldLabel htmlFor={`${id}-remark`}>
                在第 5 列附带备注
              </FieldLabel>
            </Field>
          )}
          <details open={!exported}>
            <summary className="cursor-pointer text-sm font-medium">
              字段规则与可复制示例
            </summary>
            <div className="mt-3 flex flex-col gap-4">
              {format !== "json" ? (
                <Alert>
                  <FileText />
                  <AlertTitle>固定字段顺序 · {columns.length} 列</AlertTitle>
                  <AlertDescription className="flex flex-col gap-2">
                    <p>{columns.map(({ label }) => label).join(" → ")}</p>
                    <p>
                      首行是字段名。空字段保留位置；含分隔符、换行、引号或首尾空格时，
                      自动用双引号包住，字段内的双引号写成两个双引号。
                    </p>
                    <p>
                      {kind === "outlook"
                        ? "默认导出四列凭据，可附带备注。分组等额外字段请用 JSON 保存。"
                        : "文本和 CSV 导出上述 11 列；置顶、历史记录及时间等额外字段请用 JSON 保存。"}
                    </p>
                  </AlertDescription>
                </Alert>
              ) : (
                <FieldDescription>
                  JSON 保留本次接口返回的全部账号字段，使用 accounts
                  数组，便于完整保存和再次导入。
                </FieldDescription>
              )}
              <Field>
                <FieldLabel htmlFor={`${id}-template`}>
                  格式模板（虚构数据）
                </FieldLabel>
                <Textarea
                  id={`${id}-template`}
                  value={template}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  wrap="off"
                  rows={3}
                  className="h-24 [field-sizing:fixed]"
                />
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void copyValue(template, "格式模板")}
                  >
                    <Copy data-icon="inline-start" />
                    复制模板
                  </Button>
                </div>
              </Field>
            </div>
          </details>
        </FieldGroup>
        {format === "csv" && (
          <Alert>
            <AlertTitle>
              {generated.formulas
                ? `${generated.formulas} 个字段可能被表格软件识别为公式`
                : "在表格软件中导入时，请将所有列设为文本"}
            </AlertTitle>
            <AlertDescription>
              CSV 保留凭据原值。直接打开可能把以 =、+、-、@ 开头的值执行为公式，
              或自动转换数字；请使用“导入文本”并指定列类型为文本。
            </AlertDescription>
          </Alert>
        )}
        {error && <ErrorState message={error} retry={() => void load()} />}
        <ActionError message={generated.error} />
        <Field>
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel htmlFor={`${id}-preview`}>导出预览</FieldLabel>
            {exported && (
              <Badge variant="secondary">
                {exported.accounts.length} 个账号
              </Badge>
            )}
          </div>
          <Textarea
            id={`${id}-preview`}
            value={generated.text}
            readOnly
            autoComplete="off"
            spellCheck={false}
            wrap="off"
            rows={7}
            className="h-48 [field-sizing:fixed]"
            aria-busy={busy}
            placeholder={
              busy
                ? "正在读取账号并生成导出内容…"
                : "点击“生成导出内容”后在这里预览。"
            }
          />
          <FieldDescription>
            {exported && !exported.accounts.length
              ? "没有可导出的账号，请关闭弹窗并调整选择范围。"
              : "本次最多 10,000 个账号。文本和 CSV 包含表头，复制或下载时会保留完整内容。"}
          </FieldDescription>
        </Field>
        {feedback && (
          <p role="status" className="text-sm text-muted-foreground">
            {feedback}
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="outline" onClick={dismiss}>
          关闭
        </Button>
        <BusyButton
          type="button"
          variant={ready ? "outline" : "default"}
          busy={busy}
          onClick={() => void load()}
        >
          {exported ? "重新生成" : error ? "重试生成" : "生成导出内容"}
        </BusyButton>
        {exported && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={!ready}
              onClick={() => void copyValue(generated.text, "导出内容")}
            >
              <Copy data-icon="inline-start" />
              复制内容
            </Button>
            <Button
              type="button"
              disabled={!ready}
              onClick={() => {
                try {
                  downloadExport(generated.text, format, kind);
                  setFeedback("已生成下载文件");
                } catch {
                  setFeedback("无法下载文件，请复制上方内容后手动保存");
                }
              }}
            >
              <Download data-icon="inline-start" />
              下载 {format === "text" ? "TXT" : format.toUpperCase()}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

export default AccountExportDialog;
