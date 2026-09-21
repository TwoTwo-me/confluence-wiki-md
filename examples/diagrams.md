---
type: Reference
title: Native diagram examples
description: Locally validated code blocks rendered by installed Confluence apps.
---
# Diagrams

## Mermaid

```mermaid
flowchart LR
  Markdown --> Validation
  Validation --> Confluence
```

## UML sequence

```uml
@startuml
Agent -> CLI: Upload Markdown
CLI -> CLI: Validate syntax
CLI -> Confluence: Publish native macro
Confluence --> Reader: Render diagram
@enduml
```

## PlantUML class diagram

```plantuml
@startuml
class Page {
  id
  version
}
class Markdown {
  frontMatter
  body
}
Markdown --> Page
@enduml
```
