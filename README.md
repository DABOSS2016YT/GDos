# G-Dos

**G-Dos** is a modern spreadsheet designed for developers, analysts, and data-driven workflows.
Instead of treating spreadsheets as isolated files, G-Dos integrates **databases, structured data formats, automation tools, and analytics** directly into the spreadsheet environment.

It combines the familiarity of traditional spreadsheet software with **direct database interaction, advanced automation, predictive pattern tools, and powerful export options**.

---

## Preview

<img src="https://github.com/DABOSS2016YT/GDos/blob/main/ss/Application.png?raw=true" width="100%" />

---

# Core Concept

Traditional spreadsheet tools operate primarily on static files.

G-Dos was built around a different idea:

* Spreadsheets should work **directly with databases**
* Data should be **easy to transform between formats**
* Automation should remove repetitive tasks
* Predictive tools should help expand datasets quickly

The result is a spreadsheet designed for **data pipelines, automation, and structured workflows**.

---

# Features

## Database Integration

Connect spreadsheets directly to databases and interact with them without leaving the spreadsheet interface.

Supported database engines:

* SQLite
* MySQL / MariaDB
* PostgreSQL
* MongoDB
* SQL Server
* Redis

<img src="https://github.com/DABOSS2016YT/GDos/blob/main/ss/Database_Types.png?raw=true" width="80%" />

Capabilities include:

* Query databases
* Push spreadsheet data into databases
* Use tables as spreadsheet sources
* Transform spreadsheet results into database queries

---

## Smart Pattern Prediction

G-Dos includes a **predictive pattern system** that automatically detects sequences and expands them.

Supported pattern types:

* Arithmetic sequences
* Power sequences
* Fibonacci-like sequences
* Custom generated sequences

This allows rapid dataset expansion and automation when working with ordered values.

<img src="https://github.com/DABOSS2016YT/GDos/blob/main/ss/Auto_predict.png?raw=true" width="70%" />

Examples:

| Input  | Generated |
| ------ | --------- |
| 1,2,3  | 4,5,6,7   |
| 2,4,8  | 16,32     |
| 5,8,13 | 21,34     |

---

## Charts & Data Visualization

Create charts directly from spreadsheet selections.

Supported chart types:

* Bar
* Line
* Pie
* Donut
* Scatter
* Radar
* Polar
* Horizontal Bar

Charts are customizable with:

* Titles
* Axis labels
* Legend placement
* Color palettes
* Chart dimensions
* Smooth lines

<img src="https://github.com/DABOSS2016YT/GDos/blob/main/ss/Charts.png?raw=true" width="80%" />

---

## Import Data

Load datasets from multiple structured formats.

Supported formats:

* Excel (`.xlsx`, `.xls`, `.xlsm`, `.ods`)
* CSV (`.csv`)
* Text / Log (`.txt`, `.log`)
* JSON / NDJSON (`.json`, `.ndjson`)
* Markdown tables (`.md`)
* G-Dos native (`.dosi`)

<img src="https://github.com/DABOSS2016YT/GDos/blob/main/ss/Load_Types.png?raw=true" width="60%" />

---

## Export Data

Convert spreadsheets into multiple formats for use in other systems.

Supported export formats:

* G-Dos (`.dosi`)
* Excel (`.xlsx`)
* CSV (`.csv`)
* SQL (`.sql`)
* JSON (`.json`)
* HTML (`.html`)
* Markdown (`.md`)
* PDF (`.pdf`)

<img src="https://github.com/DABOSS2016YT/GDos/blob/main/ss/Export_Types.png?raw=true" width="60%" />

---

## Spreadsheet Tools

Additional productivity tools built directly into the editor:

* Formula builder
* Auto-sum rows
* Auto-sum columns
* Smart fill
* Bulk row insertion
* Bulk column insertion
* Sorting
* Filtering
* Duplicate removal
* Find & replace
* Variable management

---

## Built-In Updater

G-Dos includes an integrated update system to keep the application current.

<img src="https://github.com/DABOSS2016YT/GDos/blob/main/ss/Auto_Updater.png?raw=true" width="70%" />

---

# Example Workflow

A typical workflow using G-Dos might look like:

1. Connect to a **database**
2. Pull a dataset into the spreadsheet
3. Clean or transform the data
4. Generate additional rows using **pattern prediction**
5. Visualize trends with **charts**
6. Export the results to **SQL, Excel, JSON, or Markdown**

---

# Why G-Dos

G-Dos bridges the gap between:

* spreadsheets
* databases
* structured data formats
* automation tools

It enables workflows that normally require **multiple applications**.

---

# Repository

GitHub repository:

https://github.com/DABOSS2016YT/GDos

---
# Versions

Each release of **G-Dos** is compiled for multiple platforms using Electron Builder.

## v1.0.0

First public release.

### Windows

* **Windows Installer (.exe)** — NSIS installer
* **Windows Portable (.exe)** — portable standalone build

Architecture:

* x64

### macOS

* **DMG Installer (.dmg)**

Architectures:

* Intel (x64)
* Apple Silicon (arm64)

### Linux

* **AppImage (.AppImage)** — portable Linux executable
* **Debian Package (.deb)** — for Debian / Ubuntu based systems

Architecture:

* x64

---

# Platform Compatibility

| Platform | Package Type     | Notes                     |
| -------- | ---------------- | ------------------------- |
| Windows  | `.exe` installer | Standard installation     |
| Windows  | `.exe` portable  | Runs without installation |
| macOS    | `.dmg`           | self-build                |
| Linux    | `.AppImage`      | Portable executable       |
| Linux    | `.deb`           | Debian / Ubuntu package   |

---

# System Requirements

Minimum requirements for running G-Dos.

| Component   | Requirement             |
| ----------- | ----------------------- |
| CPU         | 64-bit processor        |
| RAM         | 4 GB recommended        |
| Node Engine | ≥ 20                    |
| OS          | Windows / macOS / Linux |

---

# Release Distribution

Compiled builds are placed in:

```
/dist
```

Typical output files:

```
G-Dos Setup.exe
G-Dos Portable.exe
G-Dos-x64.AppImage
g-dos_1.0.0_amd64.deb
G-Dos-1.0.0.dmg
```

---

# Building Manually

Install dependencies:

```
npm install
```

Run the application:

```
npm start
```

Build for a specific platform:

```
npm run windows
npm run mac
npm run linux
```

Build all platforms:

```
npm run all
```
---
# License

See the repository for licensing information.
