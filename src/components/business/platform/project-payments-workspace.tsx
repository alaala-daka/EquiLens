"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProjectFactsPanel, type FactsPanelProps } from "./project-facts-panel"
import { ProjectPaymentsPanel } from "./project-payments-panel"

/** Official Tabs example: preserve mounted unsaved forms across the two business panels. */
export function ProjectPaymentsWorkspace(props: FactsPanelProps) {
  const [tab, setTab] = useState("facts")
  return <Tabs value={tab} onValueChange={setTab}>
    <TabsList><TabsTrigger value="facts">项目事实</TabsTrigger><TabsTrigger value="payments">款项表</TabsTrigger></TabsList>
    <TabsContent value="facts" forceMount hidden={tab !== "facts"}><ProjectFactsPanel {...props} active={props.active && tab === "facts"} /></TabsContent>
    <TabsContent value="payments" forceMount hidden={tab !== "payments"}><ProjectPaymentsPanel {...props} active={props.active && tab === "payments"} /></TabsContent>
  </Tabs>
}
