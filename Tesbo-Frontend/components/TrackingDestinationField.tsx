"use client";

import { Button } from "@/components/ui";

export type TrackingDestination = "TESBO" | "SELF";

interface Props {
  destination: TrackingDestination;
  onChange: (d: TrackingDestination) => void;
}

export default function TrackingDestinationField({ destination, onChange }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        size="sm"
        variant={destination === "TESBO" ? "primary" : "secondary"}
        onClick={() => onChange("TESBO")}
      >
        Log into Tesbo
      </Button>
      <Button
        type="button"
        size="sm"
        variant={destination === "SELF" ? "primary" : "secondary"}
        onClick={() => onChange("SELF")}
      >
        I&rsquo;ll log it in my task management system myself
      </Button>
    </div>
  );
}
