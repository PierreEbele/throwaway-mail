import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { post } from "../../api";
import { ErrorText, useToast } from "../../components/ui";
import { Field, PASSWORD_MIN } from "../auth/AuthCard";

/** Password change for local accounts; the server signs out every other session. */
export function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => post("/v1/auth/password", { current_password: current, new_password: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      toast("Password changed; your other sessions were signed out", "success");
    },
  });
  return (
    <form
      className="card mt-4 max-w-xl space-y-3 p-5 text-sm"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      <h2 className="font-semibold">Change password</h2>
      <input type="text" hidden readOnly autoComplete="username" />
      <Field
        id="pw-current"
        label="Current password"
        type="password"
        autoComplete="current-password"
        required
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <Field
        id="pw-new"
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN}
        hint={`At least ${PASSWORD_MIN} characters. Other devices are signed out.`}
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <ErrorText error={change.error} />
      <button className="btn-primary" disabled={change.isPending}>
        Change password
      </button>
    </form>
  );
}
