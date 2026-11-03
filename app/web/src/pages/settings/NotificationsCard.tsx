import { useState } from "react";
import { NOTIFY_KEY } from "../../util";

export function NotificationsCard() {
  const supported = typeof Notification !== "undefined";
  const [on, setOn] = useState(supported && localStorage.getItem(NOTIFY_KEY) === "1" && Notification.permission === "granted");
  const toggle = async () => {
    if (on) {
      localStorage.removeItem(NOTIFY_KEY);
      setOn(false);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      localStorage.setItem(NOTIFY_KEY, "1");
      setOn(true);
    }
  };
  return (
    <div className="card mt-4 max-w-xl space-y-2 p-5 text-sm">
      <h2 className="font-semibold">Desktop notifications</h2>
      {supported ? (
        <>
          <p className="text-zinc-500">
            Get a system notification when a mail arrives while this app is open in a tab (even in the background). Mails with a
            verification code show the code; click the notification to copy it.
          </p>
          <button className={on ? "btn-secondary" : "btn-primary"} onClick={toggle}>
            {on ? "Turn off" : "Turn on"}
          </button>
          {Notification.permission === "denied" && (
            <p className="text-amber-700 dark:text-amber-400">Notifications are blocked for this site in your browser settings.</p>
          )}
        </>
      ) : (
        <p className="text-zinc-500">This browser does not support notifications.</p>
      )}
    </div>
  );
}
