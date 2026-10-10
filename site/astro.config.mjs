// @ts-check
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"

// useabstract.co — the landing page lives in src/pages/index.astro; the docs
// are Starlight pages under src/content/docs/docs/ (served at /docs/...).
export default defineConfig({
  site: "https://useabstract.co",
  integrations: [
    starlight({
      title: "abstract docs",
      description:
        "Documentation for abstract — the local AI research workbench that won't write a citation it can't trace to a real source.",
      logo: {
        light: "./src/assets/logo-light.png",
        dark: "./src/assets/logo-dark.png",
        alt: "abstract",
        replacesTitle: true,
      },
      favicon: "/favicon.png",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/rabieHs/abstract" }],
      customCss: ["./src/styles/docs.css"],
      sidebar: [
        {
          label: "Start here",
          items: ["docs", "docs/install", "docs/quick-start", "docs/models"],
        },
        {
          label: "Guides",
          items: [
            "docs/workspaces",
            "docs/literature-search",
            "docs/verified-drafting",
            "docs/export",
            "docs/steering",
            "docs/skills",
            "docs/memory",
          ],
        },
        {
          label: "Reference",
          items: ["docs/cli", "docs/configuration", "docs/privacy", "docs/troubleshooting"],
        },
      ],
    }),
  ],
})
