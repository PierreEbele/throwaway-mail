import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { del, patch, post } from "../../api";
import type { Destination } from "../../types";
import { Badge, EmptyState, ErrorText, PageHeader, Spinner, confirmAction, useToast } from "../../components/ui";
import { LockIcon } from "../../components/icons";
import { invalidate } from "../../queries";
import { timeAgo } from "../../util";
import { useDestinations } from "../Addresses";
import { useAuth } from "../../auth";
import { FallbackCard, HeaderAllowlistCard } from "./ForwardingOptionsCard";
import { useT } from "../../i18n";

export function DestinationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const dests = useDestinations();
  const { cloudflareMode } = useAuth();
  const t = useT().destinations;
  const tc = useT().common;
  const [params] = useSearchParams();
  const linkResult = params.get("verified");
  const [email, setEmail] = useState("");
  // Without Cloudflare the app always sends the link itself; with it, the user may still choose to.
  const [byApp, setByApp] = useState(false);
  const appOnly = cloudflareMode === "unconfigured";
  const inv = () => invalidate(qc, ["destinations"]);
  const add = useMutation({
    mutationFn: () => post<{ destination: Destination }>("/v1/destinations", { email, verify_by: appOnly || byApp ? "app" : "cloudflare" }),
    onSuccess: (r) => {
      setEmail("");
      inv();
      if (!r.destination.last_error) toast(r.destination.verification === "app" ? t.sentApp : t.sentCf, "success");
    },
  });
  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "refresh" | "resend" | "delete" }) =>
      op === "delete" ? del(`/v1/destinations/${id}`) : post(`/v1/destinations/${id}/${op}`),
    onSuccess: (_r, v) => {
      inv();
      if (v.op === "resend") toast(t.resent, "success");
    },
    onError: (e) => toast((e as Error).message, "error"),
  });
  return (
    <>
      <PageHeader title={t.title} subtitle={t.subtitle(appOnly)} />
      {linkResult && (
        <p
          className={`card mb-4 p-3 text-sm ${linkResult === "1" ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
        >
          {linkResult === "1" ? t.linkOk : t.linkBad}
        </p>
      )}
      <form
        className="card mb-6 flex flex-wrap items-end gap-3 p-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="min-w-64 flex-1">
          <label htmlFor="dest-email" className="label">
            {t.addMailbox}
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
          {t.addSend}
        </button>
        {!appOnly && (
          <label className="flex w-full items-center gap-2 text-xs text-zinc-500">
            <input type="checkbox" checked={byApp} onChange={(e) => setByApp(e.target.checked)} />
            {t.byApp}
          </label>
        )}
        <div className="w-full">
          <ErrorText error={add.error} />
        </div>
      </form>
      {dests.isLoading && <Spinner />}
      {dests.data?.length === 0 && <EmptyState title={t.empty} />}
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
                  {d.verified
                    ? t.verified(timeAgo(d.verified_at))
                    : d.verification === "app"
                      ? d.verify_sent_at
                        ? t.linkSent(timeAgo(d.verify_sent_at))
                        : t.noLink
                      : t.waitingCf}
                </p>
                {d.last_error && <p className="text-xs text-red-600">{d.last_error}</p>}
                <PgpRow d={d} />
              </div>
              {!d.verified && (
                <>
                  {d.verification === "cloudflare" && (
                    <button className="btn-secondary" onClick={() => action.mutate({ id: d.id, op: "refresh" })}>
                      {t.checkStatus}
                    </button>
                  )}
                  <button className="btn-secondary" onClick={() => action.mutate({ id: d.id, op: "resend" })}>
                    {t.resend}
                  </button>
                </>
              )}
              <button
                className="btn-ghost text-red-600"
                onClick={() => confirmAction(t.confirmRemove(d.email)) && action.mutate({ id: d.id, op: "delete" })}
              >
                {tc.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!!dests.data?.length && <FallbackCard dests={dests.data} />}
      <HeaderAllowlistCard />
    </>
  );
}

function PgpRow({ d }: { d: Destination }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const t = useT().destinations;
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
          <LockIcon /> {t.encryptedWith}{" "}
          <code className="font-mono" title={d.pgp.fingerprint}>
            {d.pgp.fingerprint
              .slice(-16)
              .replace(/(.{4})/g, "$1 ")
              .trim()}
          </code>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={d.pgp.hide_subject} onChange={(e) => save({ pgp_hide_subject: e.target.checked })} />{" "}
            {t.hideSubject}
          </label>
          <button className="underline" onClick={() => setOpen(!open)}>
            {t.change}
          </button>
          <button className="underline" onClick={() => confirmAction(t.confirmClear) && save({ pgp_public_key: null })}>
            {t.remove}
          </button>
        </p>
      ) : (
        <button className="text-zinc-500 underline" onClick={() => setOpen(!open)}>
          {t.encrypt}
        </button>
      )}
      {open && (
        <div className="mt-2 space-y-2">
          <textarea
            className="input h-28 font-mono text-xs"
            placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label={t.pgpKey}
          />
          <p className="text-zinc-500">{t.pgpHelp}</p>
          <button className="btn-primary px-2 py-1 text-xs" disabled={!key.trim()} onClick={() => save({ pgp_public_key: key })}>
            {t.saveKey}
          </button>
        </div>
      )}
    </div>
  );
}
