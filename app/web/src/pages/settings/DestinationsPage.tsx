import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { del, patch, post } from "../../api";
import type { Destination } from "../../types";
import { Badge, EmptyState, ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../../components/ui";
import { LockIcon } from "../../components/icons";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";
import { useDestinations } from "../Addresses";

export function DestinationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const dests = useDestinations();
  const [email, setEmail] = useState("");
  const inv = () => invalidate(qc, ["destinations"]);
  const add = useMutation({
    mutationFn: () => post("/v1/destinations", { email }),
    onSuccess: () => {
      setEmail("");
      inv();
      toast("Cloudflare sent a verification e-mail to that address", "success");
    },
  });
  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "refresh" | "resend" | "delete" }) =>
      op === "delete" ? del(`/v1/destinations/${id}`) : post(`/v1/destinations/${id}/${op}`),
    onSuccess: (_r, v) => {
      inv();
      if (v.op === "resend") toast("Verification e-mail sent again", "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <>
      <PageHeader
        title="Destinations"
        subtitle="Personal mailboxes that sites can forward to. Cloudflare must verify each one (click the link in the e-mail it sends)."
      />
      <form
        className="card mb-6 flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="min-w-64 flex-1">
          <label htmlFor="dest-email" className="label">
            Add a mailbox
          </label>
          <input
            id="dest-email"
            type="email"
            required
            className="input"
            placeholder="me@personal.example"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <button className="btn-primary" disabled={add.isPending}>
          Add &amp; send verification
        </button>
        <div className="w-full">
          <ErrorText error={add.error} />
        </div>
      </form>
      {dests.isLoading && <Spinner />}
      {dests.data?.length === 0 && <EmptyState title="No destinations yet" />}
      {!!dests.data?.length && (
        <ul className="card divide-y divide-zinc-200 dark:divide-zinc-800">
          {dests.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{d.email}</span>
                  <Badge value={d.verified ? "verified" : "unverified"} />
                </div>
                <p className="text-xs text-zinc-500">
                  {d.verified ? `Verified ${timeAgo(d.verified_at)}` : "Waiting for you to click the Cloudflare verification link"}
                </p>
                {d.last_error && <p className="text-xs text-red-600">{d.last_error}</p>}
                <PgpRow d={d} />
              </div>
              {!d.verified && (
                <>
                  <button className="btn-secondary" onClick={() => action.mutate({ id: d.id, op: "refresh" })}>
                    Check status
                  </button>
                  <button className="btn-secondary" onClick={() => action.mutate({ id: d.id, op: "resend" })}>
                    Resend
                  </button>
                </>
              )}
              <button
                className="btn-ghost text-red-600"
                onClick={() => confirmAction(`Remove ${d.email}?`) && action.mutate({ id: d.id, op: "delete" })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PgpRow({ d }: { d: Destination }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const save = (body: Record<string, unknown>) =>
    patch(`/v1/destinations/${d.id}`, body).then(
      () => {
        invalidate(qc, ["destinations"]);
        setOpen(false);
        setKey("");
      },
      (e: Error) => toast(e.message, "error"),
    );
  return (
    <div className="mt-1 text-xs">
      {d.pgp ? (
        <p className="flex flex-wrap items-center gap-2 text-zinc-500">
          <LockIcon /> Encrypted with{" "}
          <code className="font-mono" title={d.pgp.fingerprint}>
            {d.pgp.fingerprint
              .slice(-16)
              .replace(/(.{4})/g, "$1 ")
              .trim()}
          </code>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={d.pgp.hide_subject} onChange={(e) => save({ pgp_hide_subject: e.target.checked })} /> hide
            subject
          </label>
          <button className="underline" onClick={() => setOpen(!open)}>
            change
          </button>
          <button className="underline" onClick={() => confirmAction("Forward in clear again?") && save({ pgp_public_key: null })}>
            remove
          </button>
        </p>
      ) : (
        <button className="text-zinc-500 underline" onClick={() => setOpen(!open)}>
          Encrypt forwarded mail with PGP…
        </button>
      )}
      {open && (
        <div className="mt-2 space-y-2">
          <textarea
            className="input h-28 font-mono text-xs"
            placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label="OpenPGP public key"
          />
          <p className="text-zinc-500">
            The Worker then sends an encrypted PGP/MIME copy instead of forwarding (needs the SEND_EMAIL binding, see docs/installation.md).
          </p>
          <button className="btn-primary px-2 py-1 text-xs" disabled={!key.trim()} onClick={() => save({ pgp_public_key: key })}>
            Save key
          </button>
        </div>
      )}
    </div>
  );
}
