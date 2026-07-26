<div align="center">

<img src="./assets/kspplogo.png" alt="Karnataka State Police Portal Logo" width="180"/>

# 🚨 Karnataka-State-Police-Portal

### **AI-Powered Law Enforcement Workspace & FIR Management System**

[![React](https://img.shields.io/badge/REACT-18.x-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![Google Gemini API](https://img.shields.io/badge/GOOGLE_GEMINI-2.0_FLASH-886FBF?style=for-the-badge&logo=googlegemini&logoColor=white)](https://ai.google.dev)
[![Groq API](https://img.shields.io/badge/GROQ-LLAMA_3.3_70B-F05032?style=for-the-badge&logo=groq&logoColor=white)](https://groq.com)
[![Node.js](https://img.shields.io/badge/NODE.JS-API_LAYER-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Tailwind CSS](https://img.shields.io/badge/TAILWIND_CSS-DESIGN-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Google Sheets API](https://img.shields.io/badge/DATABASE-GOOGLE_SHEETS_MASTER-34A853?style=for-the-badge&logo=googlesheets&logoColor=white)](https://developers.google.com/sheets/api)

**Transforming Police Operations & FIR Drafting with Autonomous Dual-Engine AI Intelligence**

---

</div>

## 📌 Executive Summary

The **Karnataka State Police Portal** is an enterprise-grade digital law enforcement platform designed to modernize case registration, investigation workflows, and administrative tracking across police units.

By integrating an autonomous **AI Copilot Engine** (powered by dual-engine **Google Gemini** and **Groq Llama-3.3** LLMs), police officers can auto-fill multi-step FIR registration forms directly from unstructured incident notes, export PDF case reports, perform flexible normalized searches on crime records, and generate real-time operational analytics.

---

## ✨ Core Key Features

### 🤖 1. Autonomous AI Copilot Assistant & PDF Exporter
* **Instant FIR Auto-Fill:** Converts raw, unstructured narrative notes (e.g., CCTV reports, verbal victim statements) into structured 7-tab FIR entries instantly.
* **Smart Crime Number Normalization:** Intelligently parses search inputs like `0011/2026`, `CR-0011/2026`, or `11/2026` to locate exact database records without manual data reformatting.
* **PDF Report Generation:** Embedded PDF export capabilities directly within the AI assistant for instant official case downloads.
* **Multilingual Intelligence:** Full bilingual query engine supporting both **English** and **Kannada (ಕನ್ನಡ)** responses tailored to state police protocols.

### 📋 2. Comprehensive Case & FIR Management
* **7-Step Registration Workflow:** Structured step-by-step FIR recording covering Case Basics, Incident Details, Complainants, Victims, Accused Profiles, Legal Acts/Sections, and Master Review.
* **Live Google Sheets Master Sync:** Acts as a real-time relational persistence layer syncing records dynamically across `CaseMaster`, `Accused`, `ComplainantDetails`, and `Consolidated_Cases`.
* **Dynamic Status Tracking:** Track FIR progress through statuses such as *Under Investigation*, *Untraced*, *Closed*, and *Charge Sheeted*.

### 🔍 3. Reference Data & Jurisdictional Management
* **Station Directory:** Operational mapping across Law & Order, Traffic, Crime, and Special Units.
* **Employee & IO Assignment:** Multi-tier officer assignment tracking with employee IDs, ranks, and court jurisdictions.
* **Interactive Timeline:** Built-in milestone view tracking FIR registration, IO assignment, evidence uploads, and statement entries.

### 📊 4. Insights & Analytics Dashboard
* Visual graphs summarizing total cases registered, heinous vs. non-heinous offence ratios, station-level activity metrics, and monthly registration trends.

---

## 🏗️ Screenshots


---

## 🛠️ Tech Stack & Technologies

* **Frontend:** React 18, Vite, Tailwind CSS, Lucide React Icons, React Router DOM
* **Backend Runtime:** Node.js (with IPv4 priority DNS resolution)
* **AI Engine (Primary):** Google Gen AI SDK (`@google/genai` - Gemini 2.0 Flash / 1.5 Flash)
* **AI Engine (Fallback):** Groq API (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`)
* **Database & Persistence Layer:** Google Sheets API v4 Integration & Local DB Backup
* **Middleware Extensions:** Custom Vite Server Plugins (`chatPlugin.mjs`, `localDbPlugin.mjs`)

---

## 📁 Repository Structure

Based on the official repository source layout:

```text
Karnataka-State-Police-Portal/
├── local_db/                 # Local offline database buffer & sync scripts
├── server/                   # Backend API handlers & plugins
│   ├── chatPlugin.mjs        # Vite middleware intercepting /api/chat
│   ├── geminiService.mjs     # AI Copilot engine logic & JSON draft extractor
│   ├── sheetsStore.mjs       # Google Sheets database connector & RBAC wrapper
│   └── rbac.mjs              # Role-Based Access Control logic
├── src/                      # React Frontend Source Code
│   ├── components/           # Reusable UI components (Sidebar, Timeline, etc.)
│   ├── context/              # React Contexts (LanguageContext, AuthContext)
│   ├── lib/                  # Helper utilities, PDF exporter, and API callers
│   └── pages/                # Application Views (NewFIR.tsx, CaseDetail, Dashboard)
├── .gitignore                # Git exclusion rules
├── index.html                # Entry HTML
├── package.json              # Project dependencies & scripts
├── postcss.config.js         # PostCSS configuration
├── tailwind.config.js        # Tailwind CSS styling configuration
├── tsconfig.json             # TypeScript configuration
└── vite.config.ts            # Vite bundler & middleware server configuration
```

---

## 🚀 Getting Started

### Prerequisites

Ensure you have the following installed on your machine:

* Node.js: `v18.x` or higher
* npm: `v9.x` or higher

### 1. Repository Setup

```bash
# Clone the repository
git clone https://github.com/Mohammad-Arshad-24/Karnataka-State-Police-Portal.git

# Navigate into the project directory
cd Karnataka-State-Police-Portal

# Install required npm dependencies
npm install
```

### 2. Environment Configuration

Create a `.env` file in the root directory and specify your API credentials:

```env
# Gemini API Key(s) - Comma-separated for quota failover
GEMINI_API_KEYS=your_gemini_api_key_1,your_gemini_api_key_2

# Groq API Key(s) - Fallback AI Engine
GROQ_API_KEYS=your_groq_api_key

# Google Sheets Integration
GOOGLE_CONSOLIDATED_SHEET_ID=your_google_sheet_id
GOOGLE_CONSOLIDATED_TAB=Consolidated_Cases
```

### 3. Running the Application

```bash
# Start the local development server with Vite API middlewares
npm run dev
```

Open your browser and navigate to `http://localhost:5173`.

---

## 🔒 Security & RBAC Compliance

The portal enforces Role-Based Access Control (RBAC) across officers, inspectors, and administrators. Confidential case files, sensitive complainant records, and restricted station data are strictly scoped based on authorization privileges and station IDs before being passed to AI models or client screens.

---

## 📄 License

Distributed under the Internal Government & Hackathon Software License. Confidential and proprietary to the Karnataka State Police Department.
