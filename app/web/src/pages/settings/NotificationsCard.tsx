import { useState } from "react";
import { NOTIFY_KEY } from "../../util";
import { useT } from "../../i18n";

export function NotificationsCard() {
  const supported = typeof Notification !== "undefined";
  const t = useT().settings.notifications;
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
      <h2 className="font-semibold">{t.title}</h2>
      {supported ? (
        <>
          <p className="text-zinc-500">{t.help}</p>
          <button className={on ? "btn-secondary" : "btn-primary"} onClick={toggle}>
            {on ? t.turnOff : t.turnOn}
          </button>
          {Notification.permission === "denied" && <p className="text-amber-700 dark:text-amber-400">{t.blocked}</p>}
        </>
      ) : (
        <p className="text-zinc-500">{t.unsupported}</p>
      )}
    </div>
  );
}
