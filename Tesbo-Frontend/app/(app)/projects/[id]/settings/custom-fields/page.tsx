"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { IconChevronRight, IconStack2 } from "@tabler/icons-react";
import {
  authMe,
  listCustomFieldDefinitions,
  listProjectMembers,
  type CustomFieldDefinition,
} from "@/lib/api";
import { Button, Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";
import CustomFieldDefinitionList from "@/components/customFields/CustomFieldDefinitionList";
import CustomFieldDefinitionFormModal from "@/components/customFields/CustomFieldDefinitionFormModal";

type ProjectMember = { userId: string; email: string; name: string; role: string; joinedAt: string };

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (["manager", "admin", "test_manager"].includes(n)) return "manager";
  return "qa_engineer";
}

export default function CustomFieldsSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [definitions, setDefinitions] = useState<CustomFieldDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CustomFieldDefinition | null>(null);

  const loadDefinitions = useCallback(async () => {
    try {
      const list = await listCustomFieldDefinitions(projectId);
      setDefinitions(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load custom fields.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      setCurrentUserId(me.userId);
      listProjectMembers(projectId).then(setProjectMembers).catch(() => {});
      loadDefinitions().catch(() => {});
    });
  }, [loadDefinitions, projectId, router]);

  const currentUserRole = currentUserId
    ? normalizeRole(projectMembers.find((m) => m.userId === currentUserId)?.role ?? "qa_engineer")
    : "qa_engineer";
  const canManage = currentUserRole === "owner" || currentUserRole === "manager";

  const header = (
    <PageHeader
      title={
        <>
          <IconStack2 size={26} stroke={1.75} />
          Custom Fields
        </>
      }
      subtitle="Capture additional test case metadata specific to this project."
      breadcrumb={
        <Link href={`/projects/${projectId}/settings?tab=customFields`} className="inline-flex items-center gap-1 hover:text-[var(--foreground)]">
          Settings <IconChevronRight size={13} /> Custom Fields
        </Link>
      }
    />
  );

  if (!canManage) {
    return (
      <StandardPageLayout header={header}>
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)]">Only project owners and managers can manage custom fields.</p>
        </Card>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout header={header}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--muted)]">Fields appear on this project&apos;s test cases in the order shown below.</p>
        <Button
          type="button"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          Add custom field
        </Button>
      </div>

      {loadError && <p className="text-sm text-[var(--error)]">{loadError}</p>}

      {!loading && (
        <CustomFieldDefinitionList
          projectId={projectId}
          definitions={definitions}
          onEdit={(definition) => {
            setEditing(definition);
            setFormOpen(true);
          }}
          onChanged={() => loadDefinitions()}
        />
      )}

      <CustomFieldDefinitionFormModal
        open={formOpen}
        projectId={projectId}
        definition={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          loadDefinitions();
        }}
      />
    </StandardPageLayout>
  );
}
