// Settings' answer to "where do our files go?", in words. The server asks by signing a real file, so this says what's true here.
import { HardDrive, KeyRound } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError, ProfileSection } from "@/components/kit";
import { useFileStorage } from "@/lib/files/client";
import { shownSize } from "@/lib/files/model";

const MODES = {
  signed: { icon: KeyRound, name: "Private storage", about: "Files stay in private storage. Each download uses a link that works for 60 seconds, made only for someone who can reach the file." },
  table: { icon: HardDrive, name: "In the database", about: "This deployment can't sign private links, so files are kept in the database and served only to people who can reach them." },
};

export function FileStorageSection() {
  const storage = useFileStorage();
  const mode = storage.data ? MODES[storage.data.mode] : null;
  return (
    <ProfileSection title="Files" description="Where this workspace keeps files, and the largest it takes.">
      {storage.error && <LoadError title="This didn't load" error={storage.error} onRetry={() => void storage.refetch()} />}
      {!storage.error && (!mode ? <Skeleton className="h-12 w-full max-w-md" /> : (
        <div data-testid="settings-storage" data-mode={storage.data?.mode} className="flex max-w-md items-start gap-3">
          <mode.icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="font-medium">{mode.name}<span className="ml-2 font-normal text-muted-foreground">Up to {shownSize(storage.data!.max_upload_bytes)} a file</span></p>
            <p className="text-pretty text-muted-foreground">{mode.about}</p>
          </div>
        </div>
      ))}
    </ProfileSection>
  );
}
