"use client"

import { useState } from "react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { UnsavedRegistry } from "@/lib/documents/unsaved-registry"
import { ProjectDraftingWorkspace } from "./project-drafting-workspace"
import { ProjectReviewWorkspace } from "./project-review-workspace"
import { ProjectVerificationWorkspace } from "./project-verification-workspace"
import { ProjectPaymentsWorkspace } from "./project-payments-workspace"
import { ProjectEvidencePanel } from "./project-evidence-panel"
import type { ProjectSummary } from "./projects-client"

/**
 * Project "业务处理" host (round five, spec 02 §5.1/§5.7).
 *
 * The top-level tabs stay "文档 / 业务处理 / 规范库"; this component only adds the
 * in-tab business selection so contract review, bid verification and drafting share
 * one workbench without new top-level tabs. Nested contents are force-mounted so
 * switching businesses preserves unsaved input; the shared UnsavedRegistry still
 * guards project/tab switches.
 */
export function ProjectBusinessWorkspace({ project, active, blocked, isCurrent, onAccessInvalid, onOpenDocuments, registry }: {
  project: ProjectSummary
  active: boolean
  blocked: boolean
  isCurrent: () => boolean
  onAccessInvalid: (failure: unknown) => void
  onOpenDocuments: () => void
  registry: UnsavedRegistry
}) {
  const [business, setBusiness] = useState("review")
  const canEdit = project.role !== "viewer"
  const canManage = project.role === "admin"
  return <Tabs value={business} onValueChange={setBusiness} className="flex flex-col gap-6">
    <TabsList>
      <TabsTrigger value="review">合同审查</TabsTrigger>
      <TabsTrigger value="payments">款项核对</TabsTrigger>
      <TabsTrigger value="evidence">证据整理</TabsTrigger>
      <TabsTrigger value="verification">投标材料核验</TabsTrigger>
      <TabsTrigger value="drafting">文书起草</TabsTrigger>
    </TabsList>
    <TabsContent value="payments" forceMount hidden={business !== "payments"}>
      <ProjectPaymentsWorkspace project={project} active={active && business === "payments"} canEdit={canEdit} blocked={blocked} isCurrent={isCurrent} onAccessInvalid={onAccessInvalid} registry={registry} />
    </TabsContent>
    <TabsContent value="evidence" forceMount hidden={business !== "evidence"} className="flex flex-col gap-6">
      <ProjectEvidencePanel project={project} active={active && business === "evidence"} canEdit={canEdit} blocked={blocked} isCurrent={isCurrent} onAccessInvalid={onAccessInvalid} registry={registry} />
    </TabsContent>
    <TabsContent value="review" forceMount hidden={business !== "review"} className="flex flex-col gap-6">
      <ProjectReviewWorkspace
        project={project}
        active={active && business === "review"}
        canEdit={canEdit}
        canManage={canManage}
        blocked={blocked}
        isCurrent={isCurrent}
        onAccessInvalid={onAccessInvalid}
        onOpenDocuments={onOpenDocuments}
        registry={registry}
      />
    </TabsContent>
    <TabsContent value="verification" forceMount hidden={business !== "verification"} className="flex flex-col gap-6">
      <ProjectVerificationWorkspace
        project={project}
        active={active && business === "verification"}
        canEdit={canEdit}
        canManage={canManage}
        blocked={blocked}
        isCurrent={isCurrent}
        onAccessInvalid={onAccessInvalid}
        onOpenDocuments={onOpenDocuments}
        registry={registry}
      />
    </TabsContent>
    <TabsContent value="drafting" forceMount hidden={business !== "drafting"} className="flex flex-col gap-6">
      <ProjectDraftingWorkspace
        project={project}
        active={active && business === "drafting"}
        canEdit={canEdit}
        canManage={canManage}
        blocked={blocked}
        isCurrent={isCurrent}
        onAccessInvalid={onAccessInvalid}
        onOpenDocuments={onOpenDocuments}
        registry={registry}
      />
    </TabsContent>
  </Tabs>
}
