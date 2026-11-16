import { useEffect, useId, useRef, useState } from "react";
import { Copy, Eye, EyeOff, ShieldCheck } from "lucide-react";
import {
  ActionError,
  BusyButton,
  ErrorState,
  Loading,
  Modal,
  ModalBody,
  ModalFooter,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { api, copy, useAction } from "@/lib/api";
import {
  generateTotp,
  normalizeTotp,
  parseTotp,
  totpWindow,
  type TotpConfig,
} from "@/lib/totp";

/** Mount only after an explicit account-level reveal action. Never prefetch from list rows. */
export function TotpDialog({
  accountId,
  email,
  close,
}: {
  accountId: number;
  email: string;
  close: () => void;
}) {
  const [revealed, setRevealed] = useState(true);
  useEffect(() => {
    if (!revealed) return;
    const hide = () => {
      if (document.hidden) setRevealed(false);
    };
    const timer = setTimeout(() => setRevealed(false), 120000);
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [revealed]);
  return (
    <Modal title="动态口令（TOTP）" description={email} close={close}>
      <ModalBody>
        {revealed ? (
          <TotpSession key={accountId} accountId={accountId} />
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p>动态口令已隐藏。重新显示时会重新读取此账号的 2FA 配置。</p>
            <Button onClick={() => setRevealed(true)}>
              <Eye data-icon="inline-start" />
              重新显示动态口令
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          口令在此浏览器计算，依赖设备时间，请开启系统自动校时。切到后台或显示 2
          分钟后自动隐藏。
        </p>
      </ModalBody>
      <ModalFooter>
        {revealed && (
          <Button variant="outline" onClick={() => setRevealed(false)}>
            <EyeOff data-icon="inline-start" />
            隐藏口令
          </Button>
        )}
        <Button variant="outline" onClick={close}>
          返回账号列表
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function TotpSession({ accountId }: { accountId: number }) {
  const [config, setConfig] = useState<TotpConfig>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setConfig(undefined);
    setError("");
    void api<{ totp_secret?: string }>(
      `/api/vault/${accountId}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        if (!data.totp_secret?.trim())
          throw new Error("此账号未保存 2FA 密钥，请先编辑账号添加。");
        // The detail endpoint also returns a password. Only keep the parsed TOTP configuration.
        setConfig(parseTotp(data.totp_secret));
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "无法读取 2FA 配置");
      });
    return () => controller.abort();
  }, [accountId, attempt]);
  if (error)
    return (
      <ErrorState message={error} retry={() => setAttempt((n) => n + 1)} />
    );
  return config ? <TotpCode config={config} /> : <Loading />;
}

function TotpCode({ config }: { config: TotpConfig }) {
  const [now, setNow] = useState(Date.now);
  const [value, setValue] = useState<{ code: string; expiresAt: number }>();
  const [error, setError] = useState("");
  const action = useAction({ inline: true });
  const mounted = useRef(true);
  const { counter, expiresAt, remainingSeconds } = totpWindow(
    config.period,
    now,
  );
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let active = true;
    setValue(undefined);
    setError("");
    void generateTotp(config, counter * config.period * 1000)
      .then((code) => {
        if (active && Date.now() < expiresAt) setValue({ code, expiresAt });
      })
      .catch(() => {
        if (active)
          setError(
            "无法计算动态口令，请确认浏览器支持 Web Crypto，并通过 HTTPS 或 localhost 访问。",
          );
      });
    return () => {
      active = false;
    };
  }, [config, counter, expiresAt]);
  const current = value?.expiresAt === expiresAt && now < value.expiresAt;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="size-4" />
        {config.algorithm} · {config.digits} 位 · 每 {config.period} 秒更新
      </div>
      {error ? (
        <ErrorState message={error} />
      ) : (
        <>
          <output
            aria-label="当前动态口令"
            className="select-text break-all font-mono text-4xl font-semibold tracking-widest tabular-nums"
          >
            {current ? value.code : "······"}
          </output>
          <div className="flex items-center gap-3">
            <progress
              className="h-2 min-w-0 flex-1 accent-primary"
              max={config.period}
              value={remainingSeconds}
              aria-label="当前口令剩余有效秒数"
            />
            <span className="text-sm tabular-nums" role="timer" aria-live="off">
              {remainingSeconds} 秒
            </span>
          </div>
          <BusyButton
            variant="secondary"
            busy={action.busy}
            disabled={!current}
            onClick={() => {
              void action.run(async () => {
                // Recompute at click time; a throttled timer must never copy an expired displayed code.
                const timestamp = Date.now();
                const code = await generateTotp(config, timestamp);
                if (!mounted.current) return;
                if (
                  Date.now() >= totpWindow(config.period, timestamp).expiresAt
                )
                  throw new Error("口令刚刚更新，请重新复制。");
                await copy(code, "动态口令");
              });
            }}
          >
            <Copy data-icon="inline-start" />
            复制当前口令
          </BusyButton>
        </>
      )}
      <ActionError message={action.error} />
    </div>
  );
}

type QrDetector = {
  new (options: { formats: string[] }): {
    detect: (source: ImageBitmap) => Promise<{ rawValue: string }[]>;
  };
  getSupportedFormats?: () => Promise<string[]>;
};
const qrDetector = () =>
  (globalThis as typeof globalThis & { BarcodeDetector?: QrDetector })
    .BarcodeDetector;

export function TotpField({
  value,
  onChange,
  error,
  disabled,
  onBusyChange,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const [validation, setValidation] = useState("");
  const [qr, setQr] = useState<"checking" | "ready" | "unsupported">(
    "checking",
  );
  const [scanning, setScanning] = useState(false);
  const [qrError, setQrError] = useState("");
  const generation = useRef(0);
  const busyRef = useRef(false);
  useEffect(() => {
    const Detector = qrDetector();
    let active = true;
    if (!Detector || typeof createImageBitmap !== "function")
      setQr("unsupported");
    else
      void (Detector.getSupportedFormats?.() ?? Promise.resolve(["qr_code"]))
        .then((formats) => {
          if (active)
            setQr(formats.includes("qr_code") ? "ready" : "unsupported");
        })
        .catch(() => {
          if (active) setQr("unsupported");
        });
    return () => {
      active = false;
      generation.current++;
    };
  }, []);
  const invalid = error || validation;
  return (
    <Field data-invalid={!!invalid} className="sm:col-span-2">
      <FieldLabel htmlFor={id}>2FA 密钥 / otpauth URI（可选）</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          autoCapitalize="none"
          maxLength={1000}
          disabled={disabled || scanning}
          aria-invalid={!!invalid}
          aria-describedby={`${id}-help${invalid ? ` ${id}-error` : ""}`}
          onChange={(e) => {
            generation.current++;
            setValidation("");
            setQrError("");
            onChange(e.target.value);
          }}
          onBlur={() => {
            try {
              if (value.trim()) normalizeTotp(value);
              setValidation("");
            } catch (e) {
              setValidation(e instanceof Error ? e.message : "2FA 配置无效");
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={visible ? "隐藏 2FA 配置" : "显示 2FA 配置"}
            aria-pressed={visible}
            disabled={disabled}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff /> : <Eye />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <FieldDescription id={`${id}-help`}>
        粘贴 Base32 密钥，或保留算法、位数与周期的完整 otpauth://totp/
        URI。留空会移除 2FA 配置。
      </FieldDescription>
      {invalid && <FieldError id={`${id}-error`}>{invalid}</FieldError>}
      {qr === "ready" ? (
        <>
          <FieldLabel htmlFor={`${id}-qr`}>
            从二维码图片读取（仅在本机识别）
          </FieldLabel>
          <Input
            id={`${id}-qr`}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={disabled || scanning}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (!file || busyRef.current) return;
              busyRef.current = true;
              const request = ++generation.current;
              setScanning(true);
              onBusyChange?.(true);
              setQrError("");
              void (async () => {
                let bitmap: ImageBitmap | undefined;
                try {
                  if (file.size > 5 * 1024 * 1024)
                    throw new Error("二维码图片最多 5 MiB，请先裁剪。");
                  if (
                    ![
                      "image/png",
                      "image/jpeg",
                      "image/webp",
                      "image/gif",
                    ].includes(file.type)
                  )
                    throw new Error("请选择 PNG、JPEG、WebP 或 GIF 图片。");
                  const Detector = qrDetector();
                  if (!Detector)
                    throw new Error(
                      "此浏览器不支持二维码识别，请粘贴 otpauth URI 或密钥。",
                    );
                  try {
                    bitmap = await createImageBitmap(file);
                  } catch {
                    throw new Error(
                      "无法读取图片，请重新选择或粘贴 otpauth URI。",
                    );
                  }
                  if (bitmap.width * bitmap.height > 16_000_000)
                    throw new Error("图片分辨率过大，请裁剪到二维码区域。");
                  let results: { rawValue: string }[];
                  try {
                    results = await new Detector({
                      formats: ["qr_code"],
                    }).detect(bitmap);
                  } catch {
                    throw new Error(
                      "浏览器未能识别二维码，请粘贴 otpauth URI 或密钥。",
                    );
                  }
                  const candidates = [
                    ...new Set(
                      results
                        .map((r) => r.rawValue)
                        .filter((v) => /^otpauth:/i.test(v)),
                    ),
                  ];
                  if (candidates.length !== 1)
                    throw new Error(
                      candidates.length
                        ? "图片含多个 2FA 二维码，请裁剪为一个。"
                        : "未找到 2FA 二维码，请换用清晰图片，或粘贴 otpauth URI。",
                    );
                  const normalized = normalizeTotp(candidates[0]);
                  if (generation.current === request) {
                    onChange(normalized);
                    setValidation("");
                  }
                } catch (e) {
                  if (generation.current === request)
                    setQrError(
                      e instanceof Error ? e.message : "无法读取二维码",
                    );
                } finally {
                  bitmap?.close();
                  busyRef.current = false;
                  if (generation.current === request) {
                    setScanning(false);
                    onBusyChange?.(false);
                  }
                }
              })();
            }}
          />
          {scanning && (
            <p role="status" className="text-sm text-muted-foreground">
              正在本机识别二维码…
            </p>
          )}
        </>
      ) : (
        <FieldDescription>
          {qr === "checking"
            ? "正在检查浏览器二维码识别能力…"
            : "当前浏览器没有可用的原生二维码识别能力。请从提供方复制 otpauth URI 或手动密钥，粘贴到上方。"}
        </FieldDescription>
      )}
      {qrError && <FieldError>{qrError}</FieldError>}
    </Field>
  );
}
