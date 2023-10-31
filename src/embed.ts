import { Document } from "langchain/document";
import { Metadata } from "./types";
import { glob } from "glob";
import { readFile } from "fs/promises";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { addDocsToVectorstore } from "./providers/sqliteVec";
import { parse } from "parse-gitignore";
import { join } from "path";

export async function embedCodebase(
  m: Metadata,
  currentCommitHash: string,
  filePaths?: string[]
) {
  console.log(
    `Loading ${filePaths ? filePaths.length : "all"} files from ${
      m.repoPath
    }...`
  );

  const defaultIgnoredExtensions = [
    "tsbuildinfo",
    "sh",
    "svg",
    "webmanifest",
    "png",
    "ico",
    "cur",
    "gif",
    "jpg",
    "jpeg",
    "xml",
    "otf",
    "woff",
    "woff2",
    "ttf",
    "eot",
    "riv",
    "toml",
    "txt"
  ];
  
  const configuredIgnoredExtensions: string[] = (process.env?.IGNORED_EXTENSIONS || "").split(',');
  
  const ignoredExtensions: string[] = [... new Set([ 
    ...defaultIgnoredExtensions, 
    ...configuredIgnoredExtensions])
  ].map((e) => `**/*.${e}`);

  const gitignore = parse(join(m.repoPath, ".gitignore")).patterns;

  const defaultIgnoredPaths = [
    "node_modules",
    "node_modules/**",
    "vendor",
    "vendor/**",
    ".git",
    ".git/**",
    "pnpm-lock.yaml",
    ".env",
    ".env.*",
    "dist",
    "dist/**",
    "**/bin",
    "**/bin/**"
  ]

  const configuredIgnoredPaths: string[] = (process.env?.IGNORED_PATHS || "").split(',');
  
  const ignoredPaths: string[] = [... new Set([ 
    ...defaultIgnoredPaths, 
    ...configuredIgnoredPaths])
  ];

  const files = await glob("**/*", {
    ignore: [
      ...ignoredPaths,
      ...gitignore,
      ...ignoredExtensions,
    ],
    cwd: m.repoPath,
    nodir: true,
  });

  let filesToEmbed = files;

  if (filePaths) {
    filesToEmbed = files.filter((f) => filePaths?.includes(f));
  }

  console.log("======================================================");
  console.log(`Found ${filesToEmbed.length} files to embed`);
  const typeStats = getTypeStats(filesToEmbed);
  const typeStatsPairs = Object.keys(typeStats).map(key=>`${key}: ${typeStats[key]}`);
  console.log(`File Types Found:  ${typeStatsPairs.join(',')}`);

  let exactFilePathsToEmbed = filesToEmbed.map((f) => `${m.repoPath}/${f}`);

  const docs = await getDocumentsForFilepaths(
    m,
    exactFilePathsToEmbed,
    currentCommitHash
  );
  const splitDocs = await splitDocuments(docs);

  console.log(`Split ${docs.length} docs into ${splitDocs.length} docs`);
  console.log("======================================================");


  await addDocsToVectorstore(splitDocs);
  console.log("======================================================\n");
}

function getTypeStats(files: String[]): Object {
  let stats = {};
  for (const file of files) {
    const fileExtension = file.split(".").pop() ?? "";
    if(!Object.keys(stats).includes(fileExtension)) { stats[fileExtension] = 0 }
    stats[fileExtension]++;
  }
  return stats;
}

async function splitDocuments(docs: Document[]) {
  const splitDocs: Document[] = [];

  for (const doc of docs) {
    const fileExtension = doc.metadata.filePath.split(".").pop() ?? "";
    const splitter = getFileSplitterForExtension(fileExtension);

    const splitDoc = await splitter.splitDocuments([doc]);

    splitDocs.push(...splitDoc);
  }

  return splitDocs;
}

function getFileSplitterForExtension(fileExtension: string) {
  const options = {
    chunkSize: 5000,
    chunkOverlap: 2000,
  };

  switch (fileExtension) {
    case "js":
      return RecursiveCharacterTextSplitter.fromLanguage("js", options);
    case "ts":
      return RecursiveCharacterTextSplitter.fromLanguage("js", options);
    case "jsx":
      return RecursiveCharacterTextSplitter.fromLanguage("js", options);
    case "tsx":
      return RecursiveCharacterTextSplitter.fromLanguage("js", options);
    case "md":
      return RecursiveCharacterTextSplitter.fromLanguage("markdown", options);
    default:
      return new RecursiveCharacterTextSplitter(options);
  }
}

function hasNullBytes(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

async function getDocumentsForFilepaths(
  m: Metadata,
  exactFilePaths: string[],
  currentCommitHash: string
) {
  const docs: Document[] = [];
  const count = exactFilePaths.length;
  let lastPct = 0;
  for (let i = 0; i < count; i++) {
    const exactFilePath = exactFilePaths[i];

    const pct = Math.trunc(i/count*100);
    if (pct % 10 == 0 && pct != lastPct) { 
      console.log(`${pct}%`); 
      lastPct = pct;
    }

    try {
      let buffer = await readFile(exactFilePath);
      let pageContent = buffer.toString();

      pageContent = pageContent.replaceAll("\u0000", "");

      if (pageContent.length <= 0 || typeof pageContent !== "string" || hasNullBytes(buffer)) {
        console.log(`SKIPPING DUE TO INVALID CONTENT: ${exactFilePath}`);
        continue;
      }

      const doc = new Document({
        pageContent,
        metadata: {
          filePath: exactFilePath,
          commitHash: currentCommitHash,
          repoPath: m.repoPath,
        },
      });

      docs.push(doc);
    } catch {
      console.log("SKIPPING: ",exactFilePath);
    }
  }
  console.log('DONE!');
  return docs;
}

