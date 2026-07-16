import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Manual Dialer Platform" },
      { name: "description", content: "WebRTC softphone + CRM for outbound dialing with Asterisk & Telnyx." },
      { property: "og:title", content: "Manual Dialer Platform" },
      { property: "og:description", content: "WebRTC softphone + CRM for outbound dialing." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-lg text-center">
        <h1 className="text-3xl font-bold">Manual Dialer</h1>
        <p className="mt-3 text-muted-foreground">
          WebRTC softphone + CRM, powered by Asterisk on your VPS and Telnyx for PSTN.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button asChild>
            <Link to="/auth">Sign in</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
