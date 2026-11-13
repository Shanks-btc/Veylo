"use client";
// Account screens (slice W6): sign in with email or a wallet, create an account, confirm the email
// address, and reset a password. The email account is for signing in and notices. It cannot sign or
// approve anything, and a password reset never restores a wallet: both screens that touch the
// account say so in plain words. The email password and a wallet's own protection (a passkey or a
// separate wallet password, used only inside the wallet page) are different secrets that never meet.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { safeNext, withNext } from "../auth/next";
import { signIn } from "../auth/sign-in";
import { SessionProvider, useQueryParam, useSession } from "../app-ui/session";
import { ErrorNote } from "../app-ui/shell";
import { WalletPicker } from "../app-ui/wallet-picker";
import { Button, Field, fieldAria, Logo, Skeleton } from "../ui/basic";
import { Card, ToastProvider } from "../ui/interactive";

const WALLET_NOT_RESTORED =
  "Resetting your password does not give you back a wallet. Only your recovery phrase or a passkey you registered can restore a Veylo wallet. Veylo can't recover it for you.";

function Frame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <SessionProvider>
      <ToastProvider>
        <main className="signin" id="main" aria-label={label}>
          <Card size="lg">
            <a href="/" aria-label="Veylo, home">
              <Logo />
            </a>
            {children}
          </Card>
        </main>
      </ToastProvider>
    </SessionProvider>
  );
}

/** Plain words for what the API said, and what to do about it. */
export function plainAuthError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401)
      return "That email and password don't match. Check them, or reset your password.";
    if (err.code === "EMAIL_TAKEN") return "That email already has an account. Sign in instead.";
    if (err.code === "WEAK_PASSWORD") return err.message;
    if (err.code === "LINK_INVALID")
      return "This link has expired or was already used. Ask for a new one.";
    if (err.status === 429) return "Too many tries. Wait a minute, then try again.";
    return err.message || "Something went wrong. Try again.";
  }
  return "Couldn't reach Veylo. Check your connection and try again.";
}

function useGoHome() {
  const { me } = useSession();
  useEffect(() => {
    if (!me) return;
    // A contractor who came from an invite link goes back to it; everyone else goes to the app.
    const back = safeNext(window.location.search);
    window.location.replace(back ?? (me.memberships.length > 0 ? "/app" : "/app/setup"));
  }, [me]);
}

/** Links between the sign-in pages keep the way back to an invite. */
function useLink(path: string): string {
  const [href, setHref] = useState(path);
  useEffect(() => setHref(withNext(path, window.location.search)), [path]);
  return href;
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  hint,
  autoComplete,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  autoComplete: string;
  error?: string | undefined;
}) {
  const [shown, setShown] = useState(false);
  return (
    <Field id={id} label={label} {...(hint ? { hint } : {})} {...(error ? { error } : {})}>
      <div className="copy-row">
        <input
          {...fieldAria(id, hint, error)}
          type={shown ? "text" : "password"}
          value={value}
          maxLength={256}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="grey"
          small
          onClick={() => setShown(!shown)}
          aria-pressed={shown}
        >
          {shown ? "Hide" : "Show"}
        </Button>
      </div>
    </Field>
  );
}

function SignInCard() {
  const { api, config, refreshMe, connectWallet } = useSession();
  useGoHome();
  const signUpHref = useLink("/app/sign-up");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);

  async function onEmail(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return setError("Enter your email and password.");
    setBusy(true);
    setError(undefined);
    try {
      await api.call("POST /auth/login", { body: { email: email.trim(), password } });
      await refreshMe();
    } catch (err) {
      setError(plainAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onWallet(w: { signer: Parameters<typeof signIn>[0]["wallet"] }) {
    setBusy(true);
    setError(undefined);
    try {
      await signIn({
        api,
        wallet: w.signer,
        authRecipient: config.authRecipient,
        now: () => new Date(),
      });
      await refreshMe();
    } catch (err) {
      setError(`Sign-in failed: ${err instanceof Error ? err.message : "error"}`);
    } finally {
      setBusy(false);
    }
  }
  void connectWallet;

  return (
    <>
      <div className="stack">
        <h1>Sign in to Veylo</h1>
        <p className="muted">Pay your team privately in USDC on NEAR.</p>
      </div>
      <form className="form" onSubmit={onEmail} noValidate>
        <Field id="email" label="Email">
          <input
            {...fieldAria("email", undefined, undefined)}
            type="email"
            value={email}
            maxLength={254}
            autoComplete="email"
            inputMode="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <PasswordField
          id="password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <Button type="submit" disabled={busy} block>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        {error ? <ErrorNote error={error} /> : null}
      </form>
      <p className="small">
        <a href="/app/forgot-password">Forgot your password?</a>
      </p>
      <div className="stack">
        <Button variant="grey" block onClick={() => setPicker(true)} disabled={busy}>
          Use a wallet instead
        </Button>
        <p className="small muted">
          Connect the NEAR wallet that holds your treasury, or your Veylo wallet. You sign one
          message; nothing moves and there is no gas.
        </p>
      </div>
      <p className="small">
        New to Veylo? <a href={signUpHref}>Create an account</a>
      </p>
      <WalletPicker
        open={picker}
        onClose={() => setPicker(false)}
        onConnected={onWallet}
        title="Sign in with a wallet"
      />
    </>
  );
}

export const SignInScreen = () => (
  <Frame label="Sign in">
    <SignInCard />
  </Frame>
);

function SignUpCard() {
  const { api, refreshMe } = useSession();
  useGoHome();
  const signInHref = useLink("/app/sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()))
      return setError("Enter a valid email address.");
    setBusy(true);
    setError(undefined);
    try {
      await api.call("POST /auth/signup", { body: { email: email.trim(), password } });
      await refreshMe();
    } catch (err) {
      setError(plainAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="stack">
        <h1>Create your account</h1>
        <p className="muted">
          Next you will make your wallet and pay your first contractor. Your email is for signing in
          and notices only.
        </p>
      </div>
      <form className="form" onSubmit={onSubmit} noValidate>
        <Field id="su-email" label="Email" {...(error && /email/i.test(error) ? { error } : {})}>
          <input
            {...fieldAria("su-email", undefined, error && /email/i.test(error) ? error : undefined)}
            type="email"
            value={email}
            maxLength={254}
            autoComplete="email"
            inputMode="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <PasswordField
          id="su-password"
          label="Password"
          value={password}
          onChange={setPassword}
          hint="At least 10 characters. Not the password for your wallet."
          autoComplete="new-password"
          error={error && !/email/i.test(error) ? error : undefined}
        />
        <Button type="submit" disabled={busy} block>
          {busy ? "Creating…" : "Create account"}
        </Button>
      </form>
      <p className="small">
        Already have an account? <a href={signInHref}>Sign in</a>
      </p>
    </>
  );
}

export const SignUpScreen = () => (
  <Frame label="Create account">
    <SignUpCard />
  </Frame>
);

function VerifyEmailCard() {
  const { api, refreshMe } = useSession();
  const token = useQueryParam("token");
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (token === undefined) return;
    if (token === null) {
      setState("failed");
      setMessage("This link is missing its code.");
      return;
    }
    let live = true;
    api.call("POST /auth/verify-email", { body: { token } }).then(
      () => {
        if (!live) return;
        setState("done");
        void refreshMe();
      },
      (err: unknown) => {
        if (!live) return;
        setState("failed");
        setMessage(plainAuthError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [api, token, refreshMe]);

  return state === "working" ? (
    <Skeleton lines={2} label="Confirming your email" />
  ) : state === "done" ? (
    <div className="stack">
      <h1>Email confirmed</h1>
      <p className="muted">Thank you. Your account is ready.</p>
      <a className="btn btn-dark" href="/app">
        Continue
      </a>
    </div>
  ) : (
    <div className="stack">
      <h1>That link didn&apos;t work</h1>
      <ErrorNote error={message} />
      <p className="muted small">
        Sign in and use &ldquo;Send me a new link&rdquo; in Settings, or ask for a new one from the
        banner at the top of the app.
      </p>
      <a className="btn btn-grey" href="/app/sign-in">
        Sign in
      </a>
    </div>
  );
}
export const VerifyEmailScreen = () => (
  <Frame label="Confirm email">
    <VerifyEmailCard />
  </Frame>
);

function ForgotCard() {
  const { api } = useSession();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()))
      return setError("Enter a valid email address.");
    setBusy(true);
    setError(undefined);
    try {
      await api.call("POST /auth/forgot-password", { body: { email: email.trim() } });
      setSent(true);
    } catch (err) {
      setError(plainAuthError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="stack">
        <h1>Reset your password</h1>
        <p className="muted">
          Enter your email and we&apos;ll send a link that works once, for one hour.
        </p>
      </div>
      <p className="draft-note" role="note">
        {WALLET_NOT_RESTORED}
      </p>
      {sent ? (
        <p role="status">
          If that address has an account, a reset link is on its way. Check your inbox and spam
          folder.
        </p>
      ) : (
        <form className="form" onSubmit={onSubmit} noValidate>
          <Field id="fp-email" label="Email" {...(error ? { error } : {})}>
            <input
              {...fieldAria("fp-email", undefined, error)}
              type="email"
              value={email}
              maxLength={254}
              autoComplete="email"
              inputMode="email"
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy} block>
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
      <p className="small">
        <a href="/app/sign-in">Back to sign in</a>
      </p>
    </>
  );
}
export const ForgotPasswordScreen = () => (
  <Frame label="Reset password">
    <ForgotCard />
  </Frame>
);

function ResetCard() {
  const { api } = useSession();
  const token = useQueryParam("token");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return setError("This link is missing its code.");
    setBusy(true);
    setError(undefined);
    try {
      await api.call("POST /auth/reset-password", { body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(plainAuthError(err));
    } finally {
      setBusy(false);
    }
  }
  return done ? (
    <div className="stack">
      <h1>Password changed</h1>
      <p className="muted">
        Everywhere you were signed in has been signed out. Sign in with your new password.
      </p>
      <a className="btn btn-dark" href="/app/sign-in">
        Sign in
      </a>
    </div>
  ) : (
    <>
      <div className="stack">
        <h1>Choose a new password</h1>
      </div>
      <p className="draft-note" role="note">
        {WALLET_NOT_RESTORED}
      </p>
      <form className="form" onSubmit={onSubmit} noValidate>
        <PasswordField
          id="rp-password"
          label="New password"
          value={password}
          onChange={setPassword}
          hint="At least 10 characters."
          autoComplete="new-password"
          error={error}
        />
        <Button type="submit" disabled={busy || token === undefined} block>
          {busy ? "Saving…" : "Save new password"}
        </Button>
      </form>
    </>
  );
}
export const ResetPasswordScreen = () => (
  <Frame label="Choose a new password">
    <ResetCard />
  </Frame>
);
