import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";
import { TopBarSlotsProvider } from "@/components/TopBarSlots";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TopBarSlotsProvider>
      <div className="tesbo-app-shell flex min-h-screen text-[var(--foreground)]">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <TopBar />
          <div className="tesbo-page">{children}</div>
        </main>
      </div>
    </TopBarSlotsProvider>
  );
}
