import { useAuth } from "../../auth";
import { Badge, PageHeader } from "../../components/ui";
import { fullDate } from "../../util";
import { BackupCard } from "./BackupCard";
import { DirectoriesCard } from "./DirectoriesCard";
import { NotificationsCard } from "./NotificationsCard";
import { PanicCard } from "./PanicCard";
import { DomainChoiceCard } from "./DomainChoiceCard";
import { PasswordCard } from "./PasswordCard";
import { TwoFactorCard } from "./TwoFactorCard";
import { PushTargetsCard } from "./PushTargetsCard";
import { SmtpPasswordsCard } from "./SmtpPasswordsCard";

export function AccountPage() {
  const { user, ssoProvider } = useAuth();
  return (
    <>
      <PageHeader title="Account" />
      <div className="card max-w-xl space-y-2 p-5 text-sm">
        <p>
          Signed in as <strong>{user?.name ?? user?.email}</strong> ({user?.email}) <Badge value={user?.role ?? "user"} />
        </p>
        <p className="text-zinc-500">
          Member since {fullDate(user?.created_at)} · last sign-in {fullDate(user?.last_login_at)}
        </p>
        <p className="text-zinc-500">
          {user?.auth === "local"
            ? "Local account: an admin manages your role."
            : `Your identity, password and two-factor settings are managed by ${ssoProvider}. Your role here follows your ${ssoProvider} groups and is refreshed at every sign-in.`}
        </p>
      </div>
      {user?.auth === "local" && <PasswordCard />}
      {user?.auth === "local" && <TwoFactorCard />}
      <DomainChoiceCard />
      <NotificationsCard />
      <PushTargetsCard />
      <SmtpPasswordsCard />
      <DirectoriesCard />
      <PanicCard />
      <BackupCard />
    </>
  );
}
