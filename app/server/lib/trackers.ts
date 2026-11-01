/** Email tracker detection: open-tracking pixels and click-tracking query parameters. */

/** Hosts (or parents) that only serve open-tracking pixels / click redirects. */
const TRACKER_HOSTS = [
  "list-manage.com",
  "mailchimp.com",
  "mcusercontent.com",
  "sendgrid.net",
  "ct.sendgrid.net",
  "mandrillapp.com",
  "mailgun.org",
  "mailgun.net",
  "hubspotlinks.com",
  "hubspotemail.net",
  "hs-analytics.net",
  "mktoresp.com",
  "mkt.com",
  "exct.net",
  "exacttarget.com",
  "sailthru.com",
  "klaviyo.com",
  "klclick.com",
  "customeriomail.com",
  "cmail19.com",
  "cmail20.com",
  "createsend.com",
  "pstmrk.it",
  "mailjet.com",
  "mjt.lu",
  "sparkpostmail.com",
  "spgo.io",
  "intercom-mail.com",
  "outreach.io",
  "yesware.com",
  "mixmax.com",
  "streak.com",
  "mailtrack.io",
  "bananatag.com",
  "getnotify.com",
  "emltrk.com",
  "salesloft.com",
  "litmus.com",
  "emailtracking.com",
  "awstrack.me",
  "convertkit-mail.com",
  "sendinblue.com",
  "brevo.com",
  "r.mail.",
  "click.",
  "trk.",
  "track.",
  "email.mg.",
];

const TRACKING_PARAMS =
  /^(utm_[a-z_]+|mc_cid|mc_eid|_hsenc|_hsmi|hsCtaTracking|mkt_tok|oly_anon_id|oly_enc_id|vero_id|vero_conv|ck_subscriber_id|trk|trkid|_ke|wickedid|yclid|gclid|fbclid|dclid|msclkid|igshid|s_cid|ncid|cmpid|sc_cid|elqTrackId|elqTrack|elq|sfmc_[a-z_]+|ml_subscriber|ml_subscriber_hash)$/i;

function host(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isTrackerHost(h: string | null): boolean {
  if (!h) return false;
  return TRACKER_HOSTS.some((t) => (t.endsWith(".") ? h.startsWith(t) || h.includes(`.${t}`) : h === t || h.endsWith(`.${t}`)));
}

/** Is this <img> a tracking pixel? (tiny, hidden, or served by a tracking host / path) */
export function isTrackingPixel(attribs: Record<string, string>): boolean {
  const src = attribs.src ?? "";
  if (!/^https?:/i.test(src)) return false;
  const w = attribs.width?.replace("px", "");
  const h = attribs.height?.replace("px", "");
  const style = (attribs.style ?? "").toLowerCase().replace(/\s/g, "");
  if ((w === "1" || w === "0") && (h === "1" || h === "0")) return true;
  if (/display:none|visibility:hidden|(?:^|;)width:[01]px.*height:[01]px|max-height:0|opacity:0/.test(style)) return true;
  if (/\/(open|track|pixel|beacon|o\.gif|wf\/open|e\/o|imp)(\b|\/|\.|\?)/i.test(src) && !/logo|banner|header/i.test(src)) return true;
  return isTrackerHost(host(src)) && !/\.(png|jpe?g|svg|webp)(\?|$)/i.test(src.split("#")[0]!);
}

/** Strips click-tracking query parameters. Returns the clean URL and whether anything was removed. */
export function cleanLink(url: string): { url: string; changed: boolean } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url, changed: false };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { url, changed: false };
  const drop = [...u.searchParams.keys()].filter((k) => TRACKING_PARAMS.test(k));
  if (!drop.length) return { url, changed: false };
  for (const k of drop) u.searchParams.delete(k);
  return { url: u.toString(), changed: true };
}
