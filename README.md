# HLS Worker Workflow (GitHub Actions)

This folder contains the files needed to set up a public GitHub Actions worker to optimize your videos for HLS streaming. It offloads all CPU and bandwidth workloads from your VPS to GitHub's free runners, giving you **unlimited, automatic HLS optimization**.

## How to Setup

### Step 1: Create a Public Repository on GitHub
1. Go to your GitHub account and create a new repository.
2. Name it something like `vault-hls-worker`.
3. Set the visibility to **Public** (required to get unlimited free actions runner minutes).
4. Initialize it with/without a README.

### Step 2: Push these Files to the Repository
Copy the contents of this `hls-worker` directory into your new repository. It should have the following file structure:
```text
├── README.md
├── optimize.js
└── .github/
    └── workflows/
        └── optimize.yml
```
Commit and push these files to the `main` branch of your new repository.

### Step 3: Create a Personal Access Token (PAT)
1. Go to your GitHub profile settings: **Developer Settings > Personal Access Tokens > Fine-grained tokens** (or classic tokens).
2. Generate a new token:
   * **Scope**: Classic token requires `repo` scope. Fine-grained token requires read and write access to **Repository Releases** on your **private storage repository**.
3. Copy the generated token.

### Step 4: Add the Secret to your Public Worker Repository
1. In your **public worker repository** on GitHub, click on **Settings** (top tab).
2. Go to **Secrets and variables > Actions** in the left sidebar.
3. Click **New repository secret**.
4. Name the secret: `PRIVATE_REPO_TOKEN`
5. Paste your Personal Access Token (PAT) into the value field and save.

## How it works under the hood
When your VPS triggers this repository with a `repository_dispatch` event:
1. GitHub spins up a runner.
2. It downloads the segmented parts of your private video using the `PRIVATE_REPO_TOKEN`.
3. It combines the parts and runs FFmpeg locally on the runner.
4. It packages HLS segments into 1GB zip files and uploads them back to the private release.
5. It sends a callback to your VPS backend to update the database state, completing the job!
