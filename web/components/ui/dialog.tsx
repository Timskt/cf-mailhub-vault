"use client";

import { cn } from "cn";
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

type FocusOrigin = { element: HTMLElement; parent?: FocusOrigin };
const focusOrigins = new WeakMap<HTMLElement, FocusOrigin | null>();
const DialogFocusContext = React.createContext<FocusOrigin | null>(null);
// Async openers often disable their button while loading, which moves focus to
// body before a Dialog exists. Track actual focus, using a weak reference so
// closed forms and their secret-bearing inputs are not retained by this module.
let lastFocused: WeakRef<HTMLElement> | undefined;
const rememberFocus = (event: FocusEvent) => {
  if (event.target instanceof HTMLElement && event.target !== document.body)
    lastFocused = new WeakRef(event.target);
};
if (typeof document !== "undefined")
  document.addEventListener("focusin", rememberFocus, true);
if (import.meta.hot)
  import.meta.hot.dispose(() =>
    document.removeEventListener("focusin", rememberFocus, true),
  );

function captureFocus(): FocusOrigin | null {
  if (typeof document === "undefined") return null;
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || element === document.body) {
    // A submit button loses focus when disabled. Preserve the originating
    // dialog's return target when its success screen replaces it afterwards.
    const dialogs = document.querySelectorAll<HTMLElement>(
      '[data-slot="dialog-content"][data-state="open"]',
    );
    const lastDialog = dialogs[dialogs.length - 1];
    const previousOrigin = lastDialog && focusOrigins.get(lastDialog);
    if (previousOrigin) return previousOrigin;
    const previous = lastFocused?.deref();
    if (!previous?.isConnected) return null;
    const previousDialog = previous.closest<HTMLElement>(
      '[data-slot="dialog-content"]',
    );
    return {
      element: previous,
      parent: (previousDialog && focusOrigins.get(previousDialog)) || undefined,
    };
  }
  const dialog = element.closest<HTMLElement>('[data-slot="dialog-content"]');
  return { element, parent: (dialog && focusOrigins.get(dialog)) || undefined };
}

function canRestoreFocus(element: HTMLElement) {
  return (
    element.isConnected &&
    element.getClientRects().length > 0 &&
    !element.matches(":disabled") &&
    !element.closest('[inert], [hidden], [aria-hidden="true"]')
  );
}

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  // Capture before the portal mounts. When one dialog replaces another in the
  // same commit, the old focused node has already gone by onOpenAutoFocus.
  const [origin] = React.useState(captureFocus);
  React.useEffect(() => {
    if (props.open) toast.dismiss();
  }, [props.open]);
  return (
    <DialogFocusContext.Provider value={origin}>
      <DialogPrimitive.Root data-slot="dialog" {...props} />
    </DialogFocusContext.Provider>
  );
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  const initialOrigin = React.useContext(DialogFocusContext);
  const origin = React.useRef<FocusOrigin | null>(null);
  const content = React.useRef<HTMLElement | null>(null);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg min-w-0 -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-popover text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
        onOpenAutoFocus={(event) => {
          const node = event.currentTarget as HTMLElement;
          content.current = node;
          origin.current = captureFocus() || initialOrigin;
          focusOrigins.set(node, origin.current);
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;
          // Auto-focusing a copy icon opens a tooltip above the new dialog.
          // Keep initial focus on the dialog for read-only content so an
          // immediate Escape reaches this layer. Explicit user focus still
          // opens tooltips normally; form inputs keep Radix's normal autofocus.
          const first = [
            ...node.querySelectorAll<HTMLElement>(
              "button, input, select, textarea, [tabindex]",
            ),
          ].find(
            (element) =>
              element.tabIndex >= 0 &&
              !element.matches(":disabled") &&
              element.getClientRects().length > 0,
          );
          if (first?.matches('[data-slot="tooltip-trigger"]')) {
            event.preventDefault();
            node.focus({ preventScroll: true });
          }
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const activeDialog = document.activeElement?.closest<HTMLElement>(
            '[role="dialog"], [role="alertdialog"]',
          );
          // Closing an old dialog must not steal focus from its replacement.
          for (
            let target = origin.current;
            target;
            target = target.parent || null
          ) {
            if (!canRestoreFocus(target.element)) continue;
            if (
              activeDialog &&
              activeDialog !== content.current &&
              !activeDialog.contains(target.element)
            )
              return;
            target.element.focus({ preventScroll: true });
            return;
          }
        }}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-3 right-3"
              size="icon"
            >
              <XIcon />
              <span className="sr-only">关闭弹窗</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex min-w-0 shrink-0 flex-col gap-1.5 border-b px-5 py-5 pr-14 sm:px-6 sm:pr-14",
        className,
      )}
      {...props}
    />
  );
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  // Position the scroll container so Radix's hidden native form controls
  // cannot contribute overflow to the fixed dialog frame.
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-5 [overflow-wrap:anywhere] *:shrink-0 sm:p-6",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t bg-muted/40 px-5 py-4 sm:flex-row sm:flex-wrap sm:justify-end sm:px-6",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">关闭</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-snug font-semibold [overflow-wrap:anywhere]",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere] *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
