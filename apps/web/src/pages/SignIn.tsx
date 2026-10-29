import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../api";
import { Card, cx } from "../ui";

export function SignIn({ signups }: { signups: boolean }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const submit = useMutation({
    mutationFn: () => (mode === "in" ? api.auth.login(email, password) : api.auth.signup(email, password, name)),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit.mutate();
  };
  const input = "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-400/20 dark:border-zinc-800 dark:bg-zinc-900";

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-violet-600">
            <span className="size-4 rounded-full bg-white" />
          </span>
          <h1 className="mt-3 text-xl font-semibold">{mode === "in" ? "Sign in to Lucid" : "Create your Lucid account"}</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">See why your agents do what they do.</p>
        </div>
        <Card className="p-5">
          <form onSubmit={onSubmit} className="space-y-3">
            {mode === "up" && (
              <label className="block space-y-1 text-sm">
                <span className="font-medium">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={input} />
              </label>
            )}
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Email</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className={input} />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Password</span>
              <input
                type="password"
                required
                minLength={mode === "up" ? 10 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "in" ? "current-password" : "new-password"}
                className={input}
              />
              {mode === "up" && <span className="text-xs text-zinc-500">At least 10 characters.</span>}
            </label>
            {submit.isError && <p className="text-sm text-rose-600">{submit.error.message}</p>}
            <button
              type="submit"
              disabled={submit.isPending}
              className={cx("w-full rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50")}
            >
              {submit.isPending ? "…" : mode === "in" ? "Sign in" : "Create account"}
            </button>
          </form>
        </Card>
        {signups && (
          <p className="text-center text-sm text-zinc-500">
            {mode === "in" ? "New here? " : "Already have an account? "}
            <button type="button" onClick={() => setMode(mode === "in" ? "up" : "in")} className="font-medium text-violet-600 dark:text-violet-400">
              {mode === "in" ? "Create an account" : "Sign in"}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
