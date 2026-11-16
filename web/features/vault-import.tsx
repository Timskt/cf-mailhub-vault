import { useRef, useState } from "react";
import { toast } from "sonner";
import { Copy, Upload } from "lucide-react";
import {
  ActionError,
  BusyButton,
  Modal,
  ModalBody,
  ModalFooter,
  SelectField,
  TextField,
} from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, copy, readFile, useAction } from "@/lib/api";
import { useWorkspace } from "@/lib/context";

type Preview = {
  valid_count: number;
  error_count: number;
  duplicate_count: number;
  rows: {
    line: number;
    platform_name?: string;
    account_email?: string;
    username?: string;
    error?: string;
    duplicate?: boolean;
  }[];
};
const formats = {
  text: {
    rule: "平台----邮箱----密码----用户名----邮箱来源----分类----状态----官网----2FA密钥----代理节点----备注",
    example:
      "GitHub----demo@example.test----example-password----demo----external----开发工具----active----https://github.com------------个人账号",
  },
  simple: {
    rule: "邮箱----密码----用户名（在下方填写默认平台）",
    example: "demo@example.test----example-password----demo",
  },
  csv: {
    rule: "首行为字段名；支持双引号、逗号和换行字段。",
    example:
      "platform_name,account_email,password,username,email_source,category,status,remark\nGitHub,demo@example.test,example-password,demo,external,开发工具,active,个人账号",
  },
  json: {
    rule: "支持账号数组及本站导出的 { accounts: […] } 文件。",
    example:
      '[{"platform_name":"GitHub","account_email":"demo@example.test","password":"example-password","email_source":"external"}]',
  },
};

export function VaultImportDialog({
  platform = "",
  close,
}: {
  platform?: string;
  close: () => void;
}) {
  const w = useWorkspace();
  const [format, setFormat] = useState<keyof typeof formats>("text");
  const [raw, setRaw] = useState("");
  const [fallback, setFallback] = useState(platform);
  const [mode, setMode] = useState("skip");
  const [preview, setPreview] = useState<Preview | null>(null);
  const version = useRef(0);
  const action = useAction({ inline: true });
  const invalidate = () => {
    version.current++;
    setPreview(null);
  };
  return (
    <Modal
      title="导入平台账号"
      description="粘贴固定格式文本、CSV 或 JSON，先校验再保存。每批最多 200 条、1 MiB。"
      close={() => {
        if (!action.busy) close();
      }}
      wide
    >
      <ModalBody>
        <ActionError message={action.error} />
        <FieldGroup>
          <SelectField
            label="格式说明"
            value={format}
            onChange={(v) => setFormat(v as keyof typeof formats)}
            options={[
              ["text", "固定文本 · 多个平台"],
              ["simple", "固定文本 · 同一平台"],
              ["csv", "CSV 表格"],
              ["json", "JSON 完整账号"],
            ]}
          />
          <Alert>
            <AlertTitle>字段规则</AlertTitle>
            <AlertDescription className="min-w-0">
              <code className="break-all">{formats[format].rule}</code>
              <p>
                空字段保留分隔符；字段含分隔符或换行时使用双引号，字段内双引号写成两个双引号。未填来源时，微软邮箱识别为
                Outlook，其余为外部邮箱。
              </p>
            </AlertDescription>
          </Alert>
          <Field>
            <FieldLabel htmlFor="vault-import-example">
              可复制示例（虚构数据）
            </FieldLabel>
            <Textarea
              id="vault-import-example"
              readOnly
              value={formats[format].example}
              rows={2}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => copy(formats[format].example)}
            >
              <Copy data-icon="inline-start" />
              复制示例
            </Button>
          </Field>
          <Field>
            <FieldLabel htmlFor="vault-import-file">从文件读取</FieldLabel>
            <Input
              id="vault-import-file"
              type="file"
              accept=".txt,.csv,.json,.tsv"
              disabled={action.busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                invalidate();
                void action.run(async () => {
                  const text = await readFile(file);
                  setRaw(text);
                  invalidate();
                });
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="vault-import-content">账号内容</FieldLabel>
            <Textarea
              id="vault-import-content"
              rows={6}
              autoComplete="off"
              spellCheck={false}
              value={raw}
              disabled={action.busy}
              onChange={(e) => {
                setRaw(e.target.value);
                invalidate();
              }}
              placeholder={formats[format].rule}
            />
            <FieldDescription>
              格式自动识别，示例不会自动写入。文本最多 11 列；JSON
              可保留置顶等额外账号信息。
            </FieldDescription>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="默认平台（可选）"
              value={fallback}
              disabled={action.busy}
              onChange={(e) => {
                setFallback(e.target.value);
                invalidate();
              }}
              placeholder="同平台简易文本时必填"
            />
            <SelectField
              label="已有账号如何处理"
              value={mode}
              onChange={setMode}
              disabled={action.busy}
              options={[
                ["skip", "跳过已有账号"],
                ["update", "更新已有账号（替换完整资料）"],
              ]}
            />
          </div>
          {mode === "update" && (
            <Alert variant="destructive">
              <AlertDescription>
                按平台、邮箱和用户名识别已有账号。更新会覆盖密码、2FA、备注和状态；未提供的字段也会使用空值或默认值，请核对完整内容。
              </AlertDescription>
            </Alert>
          )}
        </FieldGroup>
        {preview && (
          <div className="flex flex-col gap-3">
            <Alert variant={preview.error_count ? "destructive" : "default"}>
              <AlertTitle>
                {preview.valid_count} 条有效账号 · {preview.error_count} 行错误
              </AlertTitle>
              <AlertDescription>
                {preview.duplicate_count} 条批内重复，使用最后一条有效记录。
                {preview.error_count
                  ? "请修正全部错误后再导入，本次不会部分写入。"
                  : "预览已完成，尚未保存。"}
              </AlertDescription>
            </Alert>
            <div className="max-h-56 overflow-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>行</TableHead>
                    <TableHead>平台 / 邮箱</TableHead>
                    <TableHead>结果</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((r) => (
                    <TableRow key={r.line}>
                      <TableCell>{r.line}</TableCell>
                      <TableCell>
                        <div className="max-w-60 break-all whitespace-normal">
                          {r.platform_name || "—"}
                          <br />
                          {r.account_email || "—"}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-64 whitespace-normal">
                        {r.error ||
                          (r.duplicate ? "格式正确 · 批内重复" : "格式正确")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="outline" disabled={action.busy} onClick={close}>
          取消
        </Button>
        <BusyButton
          variant="outline"
          busy={action.busy}
          disabled={!raw.trim()}
          onClick={() => {
            void action.run(async () => {
              const current = version.current;
              const result = await api("/api/vault/import-preview", "POST", {
                raw_text: raw,
                platform_name: fallback,
              });
              if (current === version.current)
                setPreview(result as unknown as Preview);
            });
          }}
        >
          预览导入
        </BusyButton>
        <BusyButton
          busy={action.busy}
          disabled={!preview?.valid_count || !!preview.error_count}
          onClick={() => {
            void action.run(async () => {
              const result = await api("/api/vault/import", "POST", {
                raw_text: raw,
                platform_name: fallback,
                duplicate_mode: mode,
              });
              toast.success(result.message);
              w.refresh();
              close();
            });
          }}
        >
          <Upload data-icon="inline-start" />
          确认导入{preview?.valid_count ? ` ${preview.valid_count} 个账号` : ""}
        </BusyButton>
      </ModalFooter>
    </Modal>
  );
}
