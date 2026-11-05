import { useAuth } from "../../auth";
import { Badge, PageHeader } from "../../components/ui";
import { fullDate } from "../../util";
import { BackupCard } from "./BackupCard";
import { ImportAliasesCard } from "./ImportAliasesCard";
import { DirectoriesCard } from "./DirectoriesCard";
import { NotificationsCard } from "./NotificationsCard";
import { PanicCard } from "./PanicCard";
import { DomainChoiceCard } from "./DomainChoiceCard";
import { PasswordCard } from "./PasswordCard";
import { TwoFactorCard } from "./TwoFactorCard";
import { PasskeysCard } from "./PasskeysCard";
import { PushTargetsCard } from "./PushTargetsCard";
import { SmtpPasswordsCard } from "./SmtpPasswordsCard";
import { AddressSettingsCard } from "./AddressSettingsCard";
import { LanguageCard } from "./LanguageCard";
import { useT } from "../../i18n";

export function AccountPage() {
  const { user, ssoProvider } = useAuth();
  const t = useT().account;
  return (
    <>
      <PageHeader title={t.title} />
      <div className="card max-w-xl space-y-2 p-5 text-sm">
        <p>
          {t.signedInAs} <strong>{user?.name ?? user?.email}</strong> ({user?.email}) <Badge value={user?.role ?? "user"} />
        </p>
        <p className="text-zinc-500">{t.since(fullDate(user?.created_at), fullDate(user?.last_login_at))}</p>
        <p className="text-zinc-500">{user?.auth === "local" ? t.local : t.sso(ssoProvider ?? "SSO")}</p>
      </div>
      <LanguageCard />
      {user?.auth === "local" && <PasswordCard />}
      {user?.auth === "local" && <TwoFactorCard />}
      {user?.auth === "local" && <PasskeysCard />}
      <DomainChoiceCard />
      <AddressSettingsCard />
      <NotificationsCard />
      <PushTargetsCard />
      <SmtpPasswordsCard />
      <DirectoriesCard />
      <PanicCard />
      <BackupCard />
      <ImportAliasesCard />
    </>
  );
}
