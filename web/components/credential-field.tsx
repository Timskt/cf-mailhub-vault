import { Field, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { copy } from "@/lib/api";
import { Copy, Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";

/** Credentials are loaded only by an authenticated account-detail request. */
export function CredentialField({
  label = "密码",
  value,
  onChange,
  disabled,
  required,
  placeholder,
  minLength,
}: {
  label?: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  minLength?: number;
}) {
  const id = useId();
  const [visible, setVisible] = useState(true);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          readOnly={!onChange}
          disabled={disabled}
          required={required}
          minLength={minLength}
          maxLength={1000}
          placeholder={placeholder}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            type="button"
            disabled={disabled}
            aria-label={`${visible ? "隐藏" : "显示"}${label}`}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff /> : <Eye />}
          </InputGroupButton>
          <InputGroupButton
            type="button"
            disabled={disabled || !value}
            aria-label={`复制${label}`}
            onClick={() => void copy(value, label)}
          >
            <Copy />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
}
