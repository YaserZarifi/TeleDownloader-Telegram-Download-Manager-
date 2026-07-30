/**
 * Login. Four possible steps — API credentials, phone, code, 2FA password —
 * each rendered as its own screen rather than one long form, because they are
 * genuinely sequential and each depends on a round-trip to Telegram.
 *
 * Nothing entered here is ever logged or echoed back. The api_hash and the 2FA
 * password are write-only from the UI's perspective: they go straight to Rust,
 * which hands them to the keyring (§10) and never returns them.
 */

import type { AuthState } from "../lib/types";
import * as ipc from "../lib/ipc";
import { icon } from "../lib/icons";
import { el, toast } from "../lib/ui";

export interface LoginView {
  el: HTMLElement;
  setState(state: AuthState): void;
}

const STEPS = ["needs_credentials", "needs_phone", "needs_code", "needs_password"] as const;

export function createLogin(opts: { onAuthenticated: (state: AuthState) => void }): LoginView {
  const root = el("div.auth");
  const card = el("div.auth-card.panel");
  root.append(card);

  let busy = false;
  let current: AuthState = { stage: "needs_credentials" };

  /* ---------- shared chrome ---------------------------------------------- */

  const brand = (title: string, blurb: string) =>
    el("div.auth-brand", {}, [
      el("span", { html: icon("wire", 30) }),
      el("h1", {}, title),
      el("p", {}, blurb),
    ]);

  /** The step rail is honest about progress: 2FA only appears once Telegram
   *  actually asks for it, so the track doesn't promise a step that may
   *  never come. */
  const stepRail = (stage: string) => {
    const visible = STEPS.filter(
      (s) => s !== "needs_password" || stage === "needs_password"
    );
    const idx = visible.indexOf(stage as (typeof STEPS)[number]);
    return el(
      "div.auth-steps",
      { role: "progressbar", "aria-valuenow": idx + 1, "aria-valuemin": 1, "aria-valuemax": visible.length, "aria-label": `Sign-in step ${idx + 1} of ${visible.length}` },
      visible.map((_, i) =>
        el("span.auth-step", {
          "data-done": i < idx ? "true" : "false",
          "data-current": i === idx ? "true" : "false",
        })
      )
    );
  };

  /** Errors live next to the field that caused them, never only at the top. */
  const errorSlot = () => el("div", { role: "alert", "aria-live": "assertive" });

  function showError(slot: HTMLElement, message: string): void {
    slot.replaceChildren(
      el("p.field-error", {}, [el("span", { html: icon("alert", 14) }), el("span.selectable", {}, message)])
    );
  }

  /** Runs a backend call with a single in-flight guard, a busy label on the
   *  submit button, and inline error reporting. */
  async function submit(
    button: HTMLButtonElement,
    slot: HTMLElement,
    label: string,
    fn: () => Promise<AuthState>
  ): Promise<void> {
    if (busy) return;
    busy = true;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    slot.replaceChildren();
    try {
      const next = await fn();
      if (next.stage === "error") {
        showError(slot, next.message);
        // A non-recoverable error means the flow has to restart from the top.
        if (!next.recoverable) setState({ stage: "needs_phone", api_id: 0 });
      } else {
        setState(next);
        if (next.stage === "ready") opts.onAuthenticated(next);
      }
    } catch (e) {
      showError(slot, e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = original;
    }
  }

  /* ---------- step 1: API credentials ------------------------------------ */

  function credentialsScreen(): HTMLElement {
    const slot = errorSlot();
    const apiId = el("input.input", {
      id: "api-id",
      type: "text",
      inputmode: "numeric",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "1234567",
    }) as HTMLInputElement;
    const apiHash = el("input.input", {
      id: "api-hash",
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "0123456789abcdef0123456789abcdef",
    }) as HTMLInputElement;

    const go = el("button.btn.btn-primary", { type: "submit" }, "Save credentials") as HTMLButtonElement;

    const openPortal = el("button.btn", { type: "button" }, [
      el("span", { html: icon("external", 15) }),
      el("span", {}, "Open my.telegram.org"),
    ]) as HTMLButtonElement;
    openPortal.addEventListener("click", () => {
      ipc.openUrl("https://my.telegram.org/apps").catch(() => {
        toast("Couldn't open your browser — visit my.telegram.org/apps manually.", "error");
      });
    });

    /** A numbered step, so this reads as a short procedure rather than a form
     *  demanding two opaque secrets. */
    const step = (n: number, text: string, extra?: HTMLElement) =>
      el("li.setup-step", {}, [
        el("span.setup-num.mono", {}, String(n)),
        el("div", {}, [el("div", { text }), extra ?? null]),
      ]);

    const form = el("form.auth-form", { novalidate: true }, [
      // The single most important sentence on this screen: this is not a bot,
      // and it is not a different kind of account. Users have every reason to
      // assume otherwise from the field names alone.
      el("p.auth-note", {}, [
        el("b", {}, "You'll sign in with your normal phone number in a moment. "),
        el("span", {}, "This one-time step just registers TeleWire as an app with Telegram — the same thing Telegram Desktop does. It is not a bot, and it doesn't change which account you use or what you can download."),
      ]),

      el("ol.setup-steps", {}, [
        step(1, "Open my.telegram.org and sign in with your phone number.", openPortal),
        step(2, "Choose “API development tools”, then fill in any app name — “TeleWire” is fine."),
        step(3, "Copy the two values it shows you into the boxes below."),
      ]),

      el("div.field", {}, [
        el("label", { for: "api-id" }, "App api_id"),
        apiId,
      ]),
      el("div.field", {}, [
        el("label", { for: "api-hash" }, "App api_hash"),
        apiHash,
        el("p.field-hint", {}, "Saved to your operating system's keychain, on this machine only. You'll never be asked again."),
      ]),
      slot,
      go,
    ]);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const id = Number(apiId.value.trim());
      const hash = apiHash.value.trim();
      if (!Number.isInteger(id) || id <= 0) {
        apiId.setAttribute("aria-invalid", "true");
        showError(slot, "API ID must be the numeric id shown on my.telegram.org.");
        apiId.focus();
        return;
      }
      if (hash.length < 32) {
        apiHash.setAttribute("aria-invalid", "true");
        showError(slot, "API hash looks too short — it's a 32-character hex string.");
        apiHash.focus();
        return;
      }
      apiId.removeAttribute("aria-invalid");
      apiHash.removeAttribute("aria-invalid");
      void submit(go, slot, "Saving…", () => ipc.saveCredentials(id, hash));
    });

    return el("div", {}, [
      brand("ONE-TIME SETUP", "About a minute, once. After this you only ever enter your phone number."),
      stepRail("needs_credentials"),
      form,
    ]);
  }

  /* ---------- step 2: phone ---------------------------------------------- */

  function phoneScreen(): HTMLElement {
    const slot = errorSlot();
    const phone = el("input.input", {
      id: "phone",
      type: "tel",
      autocomplete: "tel",
      placeholder: "+1 555 0100",
    }) as HTMLInputElement;
    const go = el("button.btn.btn-primary", { type: "submit" }, "Send code") as HTMLButtonElement;

    const form = el("form.auth-form", { novalidate: true }, [
      el("div.field", {}, [
        el("label", { for: "phone" }, "Phone number"),
        phone,
        el("p.field-hint", {}, "Include the country code. Telegram will send a login code to your other devices."),
      ]),
      slot,
      go,
    ]);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = phone.value.replace(/[\s()-]/g, "");
      if (!/^\+?\d{6,15}$/.test(value)) {
        phone.setAttribute("aria-invalid", "true");
        showError(slot, "That doesn't look like a phone number with a country code.");
        phone.focus();
        return;
      }
      phone.removeAttribute("aria-invalid");
      void submit(go, slot, "Sending…", () => ipc.loginStart(value));
    });

    return el("div", {}, [
      brand("SIGN IN", "Your own Telegram account, exactly as the official app uses it."),
      stepRail("needs_phone"),
      form,
    ]);
  }

  /* ---------- step 3: code ------------------------------------------------ */

  function codeScreen(phoneNumber: string, length: number): HTMLElement {
    const slot = errorSlot();
    const slots: HTMLInputElement[] = [];

    /** Segmented entry: one box per digit, with paste, backspace and arrow
     *  handling. A code is a fixed-length instrument reading, so it should
     *  look like one — and per-digit boxes make a typo obvious at a glance. */
    const strip = el("div.code-slots", { role: "group", "aria-label": `Login code, ${length} digits` });
    for (let i = 0; i < length; i++) {
      const box = el("input", {
        type: "text",
        inputmode: "numeric",
        autocomplete: i === 0 ? "one-time-code" : "off",
        maxlength: "1",
        "aria-label": `Digit ${i + 1}`,
      }) as HTMLInputElement;

      box.addEventListener("input", () => {
        box.value = box.value.replace(/\D/g, "").slice(-1);
        if (box.value && i < length - 1) slots[i + 1].focus();
        if (slots.every((s) => s.value)) tryVerify();
      });
      box.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" && !box.value && i > 0) slots[i - 1].focus();
        if (e.key === "ArrowLeft" && i > 0) slots[i - 1].focus();
        if (e.key === "ArrowRight" && i < length - 1) slots[i + 1].focus();
      });
      box.addEventListener("paste", (e) => {
        e.preventDefault();
        const digits = (e.clipboardData?.getData("text") ?? "").replace(/\D/g, "");
        for (let j = 0; j < length - i; j++) slots[i + j].value = digits[j] ?? "";
        slots[Math.min(i + digits.length, length - 1)].focus();
        if (slots.every((s) => s.value)) tryVerify();
      });

      slots.push(box);
      strip.append(box);
    }

    const go = el("button.btn.btn-primary", { type: "submit" }, "Verify") as HTMLButtonElement;

    function tryVerify(): void {
      const code = slots.map((s) => s.value).join("");
      if (code.length !== length) return;
      void submit(go, slot, "Verifying…", async () => {
        const next = await ipc.loginSubmitCode(code);
        // A rejected code should not leave stale digits sitting in the boxes.
        if (next.stage === "error" && next.recoverable) {
          slots.forEach((s) => (s.value = ""));
          slots[0].focus();
        }
        return next;
      });
    }

    const form = el("form.auth-form", { novalidate: true }, [
      strip,
      el("p.field-hint", { style: "text-align:center" }, `Sent to ${phoneNumber}. Check your other Telegram apps.`),
      slot,
      go,
      el("button.btn.btn-ghost", { type: "button" }, "Use a different number"),
    ]);

    (form.lastElementChild as HTMLButtonElement).addEventListener("click", () => {
      setState({ stage: "needs_phone", api_id: 0 });
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      tryVerify();
    });

    queueMicrotask(() => slots[0]?.focus());

    return el("div", {}, [
      brand("LOGIN CODE", "Telegram sent a code to your account."),
      stepRail("needs_code"),
      form,
    ]);
  }

  /* ---------- step 4: 2FA -------------------------------------------------- */

  function passwordScreen(hint: string | null): HTMLElement {
    const slot = errorSlot();
    const pw = el("input.input", {
      id: "twofa",
      type: "password",
      autocomplete: "current-password",
      placeholder: "Your cloud password",
    }) as HTMLInputElement;
    const go = el("button.btn.btn-primary", { type: "submit" }, "Unlock") as HTMLButtonElement;

    const form = el("form.auth-form", { novalidate: true }, [
      el("div.field", {}, [
        el("label", { for: "twofa" }, "Two-factor password"),
        pw,
        hint
          ? el("p.field-hint", {}, `Hint: ${hint}`)
          : el("p.field-hint", {}, "This is your Telegram cloud password, not the login code."),
      ]),
      slot,
      go,
    ]);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!pw.value) {
        showError(slot, "Enter your two-factor password.");
        pw.focus();
        return;
      }
      void submit(go, slot, "Checking…", () => ipc.loginSubmitPassword(pw.value));
    });

    queueMicrotask(() => pw.focus());

    return el("div", {}, [
      brand("TWO-FACTOR", "Your account has a cloud password enabled."),
      stepRail("needs_password"),
      form,
    ]);
  }

  /* ---------- render ------------------------------------------------------ */

  function setState(state: AuthState): void {
    current = state;
    switch (state.stage) {
      case "needs_credentials":
        card.replaceChildren(credentialsScreen());
        break;
      case "needs_phone":
        card.replaceChildren(phoneScreen());
        break;
      case "needs_code":
        card.replaceChildren(codeScreen(state.phone, state.code_length ?? 5));
        break;
      case "needs_password":
        card.replaceChildren(passwordScreen(state.hint));
        break;
      case "error":
        // A hard error with nowhere to go: show it and offer a clean restart.
        card.replaceChildren(
          el("div", {}, [
            brand("CONNECTION FAILED", "TeleWire couldn't reach Telegram."),
            el("p.field-error.selectable", {}, state.message),
            (() => {
              const b = el("button.btn.btn-primary", { type: "button" }, "Start over");
              b.addEventListener("click", () => setState({ stage: "needs_credentials" }));
              return b;
            })(),
          ])
        );
        break;
      case "ready":
        break;
    }
    // Move focus to the first field of the new step so keyboard users aren't
    // stranded at the top of the document after each transition.
    if (state.stage !== "needs_code" && state.stage !== "needs_password") {
      queueMicrotask(() => card.querySelector<HTMLElement>("input")?.focus());
    }
  }

  setState(current);

  return {
    el: root,
    setState,
  };
}
