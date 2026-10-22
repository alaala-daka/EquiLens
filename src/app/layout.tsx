import type { Metadata } from "next";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  title: "衡鉴 EquiLens",
  description: "工程承包企业法律风险与文书协同平台",
  icons: { icon: "/brand.svg" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body><TooltipProvider>{children}</TooltipProvider></body>
    </html>
  );
}
