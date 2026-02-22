const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── In-memory job store ───────────────────────────────────────────────────────
let crawlSessions = {}; // sessionId -> { jobs, logs, done, error }

function makeSession() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  crawlSessions[id] = { jobs: [], logs: [], done: false, error: null };
  return id;
}

// ─── Job sources (basic mode) ──────────────────────────────────────────────────
const SOURCES = [
  {
    name: "RemoteOK",
    url: "https://remoteok.com/remote-machine-learning-jobs",
    scrape: scrapeRemoteOK,
  },
  {
    name: "We Work Remotely",
    url: "https://weworkremotely.com/categories/remote-programming-jobs",
    scrape: scrapeWWR,
  },
  {
    name: "HN Who's Hiring (ML)",
    url: "https://hn.algolia.com/api/v1/search?query=machine+learning+hiring&tags=ask_hn&hitsPerPage=20",
    scrape: scrapeHN,
  },
];

async function scrapeRemoteOK(log) {
  log("Fetching RemoteOK ML jobs...");
  try {
    const { data } = await axios.get(
      "https://remoteok.com/api?tag=machine-learning",
      { headers: { "User-Agent": "ml-job-crawler/1.0" }, timeout: 15000 }
    );
    const jobs = (Array.isArray(data) ? data : [])
      .filter((j) => j && j.position)
      .slice(0, 20)
      .map((j) => ({
        id: `rok-${j.id || j.slug}`,
        title: j.position,
        company: j.company || "Unknown",
        location: j.location || "Remote",
        url: j.url || `https://remoteok.com/l/${j.slug}`,
        tags: (j.tags || []).slice(0, 5),
        date: j.date ? new Date(j.date * 1000).toISOString() : new Date().toISOString(),
        source: "RemoteOK",
        description: j.description ? j.description.replace(/<[^>]+>/g, "").slice(0, 300) : "",
      }));
    log(`RemoteOK: found ${jobs.length} ML jobs.`);
    return jobs;
  } catch (err) {
    log(`RemoteOK fetch failed: ${err.message}`);
    return [];
  }
}

async function scrapeWWR(log) {
  log("Fetching We Work Remotely ML jobs...");
  try {
    const { data } = await axios.get(
      "https://weworkremotely.com/remote-jobs/search?term=machine+learning",
      {
        headers: {
          "User-Agent": "ml-job-crawler/1.0",
          Accept: "text/html",
        },
        timeout: 15000,
      }
    );
    const $ = cheerio.load(data);
    const jobs = [];
    $("ul.jobs li.feature").each((_, el) => {
      const $el = $(el);
      const anchor = $el.find("a").first();
      const href = anchor.attr("href") || "";
      const title = $el.find(".title").text().trim();
      const company = $el.find(".company").text().trim();
      const region = $el.find(".region").text().trim();
      if (title) {
        jobs.push({
          id: `wwr-${Buffer.from(href).toString("base64").slice(0, 12)}`,
          title,
          company: company || "Unknown",
          location: region || "Remote",
          url: href.startsWith("http") ? href : `https://weworkremotely.com${href}`,
          tags: [],
          date: new Date().toISOString(),
          source: "We Work Remotely",
          description: "",
        });
      }
    });
    log(`We Work Remotely: found ${jobs.length} ML jobs.`);
    return jobs.slice(0, 20);
  } catch (err) {
    log(`We Work Remotely fetch failed: ${err.message}`);
    return [];
  }
}

async function scrapeHN(log) {
  log("Fetching Hacker News ML hiring posts...");
  try {
    const { data } = await axios.get(
      "https://hn.algolia.com/api/v1/search?query=machine+learning+engineer+hiring&tags=ask_hn&hitsPerPage=15",
      { timeout: 15000 }
    );
    const hits = (data.hits || []).filter(
      (h) =>
        h.title &&
        (h.title.toLowerCase().includes("who is hiring") ||
          h.title.toLowerCase().includes("who's hiring"))
    );
    const jobs = hits.map((h) => ({
      id: `hn-${h.objectID}`,
      title: h.title,
      company: "Various (HN thread)",
      location: "Various / Remote",
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      tags: ["hiring", "ML", "HN"],
      date: h.created_at || new Date().toISOString(),
      source: "Hacker News",
      description: h.story_text ? h.story_text.replace(/<[^>]+>/g, "").slice(0, 300) : "",
    }));
    log(`Hacker News: found ${jobs.length} relevant posts.`);
    return jobs;
  } catch (err) {
    log(`Hacker News fetch failed: ${err.message}`);
    return [];
  }
}

// ─── Basic crawl ───────────────────────────────────────────────────────────────
async function runBasicCrawl(sessionId) {
  const session = crawlSessions[sessionId];
  const log = (msg) => {
    console.log(`[${sessionId}] ${msg}`);
    session.logs.push({ time: new Date().toISOString(), msg });
  };

  log("Starting basic ML job crawl...");

  const seenIds = new Set();
  for (const source of SOURCES) {
    log(`--- Crawling ${source.name} ---`);
    try {
      const jobs = await source.scrape(log);
      for (const job of jobs) {
        if (!seenIds.has(job.id)) {
          seenIds.add(job.id);
          session.jobs.push(job);
        }
      }
    } catch (err) {
      log(`Error crawling ${source.name}: ${err.message}`);
    }
  }

  log(`Crawl complete. Total unique jobs found: ${session.jobs.length}`);
  session.done = true;
}

// ─── Advanced crawl (LangGraph) ────────────────────────────────────────────────
async function runAdvancedCrawl(sessionId, apiKey, model) {
  const session = crawlSessions[sessionId];
  const log = (msg) => {
    console.log(`[${sessionId}] ${msg}`);
    session.logs.push({ time: new Date().toISOString(), msg });
  };

  log("Starting advanced ML job crawl with LangGraph deep research...");

  let StateAnnotation, END, START, StateGraph, ChatOpenAI;
  try {
    ({ Annotation: StateAnnotation, END, START } = require("@langchain/langgraph"));
    ({ StateGraph } = require("@langchain/langgraph"));
    ({ ChatOpenAI } = require("@langchain/openai"));
  } catch (err) {
    log(`Failed to load LangGraph/OpenAI modules: ${err.message}`);
    session.error = "LangGraph modules not available. Run npm install first.";
    session.done = true;
    return;
  }

  const llm = new ChatOpenAI({
    apiKey,
    model: model || "gpt-4o-mini",
    temperature: 0,
  });

  // Graph state shape
  const GraphState = StateAnnotation.Root({
    jobs: StateAnnotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
    logs: StateAnnotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
    searchQueries: StateAnnotation({ reducer: (_, b) => b, default: () => [] }),
    rawResults: StateAnnotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
    iteration: StateAnnotation({ reducer: (_, b) => b, default: () => 0 }),
  });

  // Node: plan search queries
  async function planSearches(state) {
    log("LangGraph: Planning search strategy...");
    const prompt = `You are a job search expert. Generate 5 specific search queries to find machine learning, AI, and data science job postings from various sources.
Focus on: ML Engineer, AI Researcher, Data Scientist, MLOps, NLP Engineer positions.
Return ONLY a JSON array of query strings, no explanation.
Example: ["machine learning engineer remote 2024", "AI researcher startup hiring"]`;

    const response = await llm.invoke(prompt);
    let queries;
    try {
      const text = response.content.trim().replace(/```json\n?|\n?```/g, "");
      queries = JSON.parse(text);
    } catch {
      queries = [
        "machine learning engineer jobs remote",
        "AI researcher positions 2024",
        "MLOps engineer hiring",
        "NLP engineer job openings",
        "deep learning engineer positions",
      ];
    }
    log(`LangGraph: Planned ${queries.length} search queries.`);
    session.logs.push(...state.logs);
    return { searchQueries: queries, logs: [`Planned queries: ${queries.join(", ")}`] };
  }

  // Node: basic crawl with all sources
  async function crawlSources(state) {
    log("LangGraph: Running basic source crawl...");
    const seenIds = new Set();
    const allJobs = [];
    for (const source of SOURCES) {
      log(`LangGraph crawling ${source.name}...`);
      try {
        const jobs = await source.scrape(log);
        for (const job of jobs) {
          if (!seenIds.has(job.id)) {
            seenIds.add(job.id);
            allJobs.push(job);
          }
        }
      } catch (err) {
        log(`Error: ${err.message}`);
      }
    }
    // Sync logs to session
    for (const entry of session.logs) {
      if (!state.logs.find((l) => l.msg === entry.msg)) {
        state.logs.push(entry);
      }
    }
    return { rawResults: allJobs, logs: [`Crawled ${allJobs.length} raw jobs`] };
  }

  // Node: LLM enrichment / filtering
  async function enrichJobs(state) {
    log("LangGraph: Enriching and filtering jobs with LLM...");
    const jobs = state.rawResults;
    if (!jobs.length) {
      return { jobs: [], logs: ["No jobs to enrich"] };
    }

    const sample = jobs.slice(0, 30).map((j) => ({
      id: j.id,
      title: j.title,
      company: j.company,
      description: j.description,
    }));

    const prompt = `You are an expert ML job curator. Given these job listings, identify which are genuinely machine learning, AI, or data science related.
Return a JSON array of objects with fields: id, relevanceScore (1-10), mlSubfield (e.g. "NLP", "CV", "MLOps", "General ML"), seniorityLevel ("junior", "mid", "senior", "staff", "unknown").
Only include jobs with relevanceScore >= 6.

Jobs: ${JSON.stringify(sample, null, 2)}

Return ONLY valid JSON array, no explanation.`;

    let enriched = [];
    try {
      const response = await llm.invoke(prompt);
      const text = response.content.trim().replace(/```json\n?|\n?```/g, "");
      enriched = JSON.parse(text);
      log(`LangGraph: LLM scored ${enriched.length} relevant ML jobs.`);
    } catch (err) {
      log(`LangGraph: LLM enrichment parse failed, using all jobs. ${err.message}`);
      enriched = jobs.map((j) => ({ id: j.id, relevanceScore: 7, mlSubfield: "General ML", seniorityLevel: "unknown" }));
    }

    const enrichedMap = {};
    for (const e of enriched) enrichedMap[e.id] = e;

    const finalJobs = jobs
      .filter((j) => enrichedMap[j.id])
      .map((j) => ({
        ...j,
        relevanceScore: enrichedMap[j.id].relevanceScore,
        mlSubfield: enrichedMap[j.id].mlSubfield,
        seniorityLevel: enrichedMap[j.id].seniorityLevel,
        advancedMode: true,
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    return { jobs: finalJobs, logs: [`Enriched ${finalJobs.length} ML-relevant jobs`] };
  }

  // Node: generate summary
  async function summarize(state) {
    log("LangGraph: Generating research summary...");
    const jobs = state.jobs;
    if (!jobs.length) {
      return { logs: ["No jobs found to summarize"] };
    }

    const subfields = {};
    for (const j of jobs) {
      subfields[j.mlSubfield] = (subfields[j.mlSubfield] || 0) + 1;
    }

    const prompt = `You are an ML job market analyst. Based on these ${jobs.length} ML job listings, write a 2-3 sentence summary of the current ML job market trends.
Top companies hiring: ${[...new Set(jobs.slice(0, 10).map((j) => j.company))].join(", ")}
Subfields distribution: ${JSON.stringify(subfields)}
Top job titles: ${[...new Set(jobs.slice(0, 10).map((j) => j.title))].join(", ")}

Write only the summary, no headers.`;

    try {
      const response = await llm.invoke(prompt);
      const summary = response.content.trim();
      session.summary = summary;
      log(`LangGraph: Market summary generated.`);
      return { logs: [`Summary: ${summary}`] };
    } catch (err) {
      log(`LangGraph: Summary generation failed: ${err.message}`);
      return { logs: ["Summary generation failed"] };
    }
  }

  // Build and run the graph
  const workflow = new StateGraph(GraphState)
    .addNode("plan", planSearches)
    .addNode("crawl", crawlSources)
    .addNode("enrich", enrichJobs)
    .addNode("summarize", summarize)
    .addEdge(START, "plan")
    .addEdge("plan", "crawl")
    .addEdge("crawl", "enrich")
    .addEdge("enrich", "summarize")
    .addEdge("summarize", END);

  const graph = workflow.compile();

  try {
    const result = await graph.invoke({ jobs: [], logs: [], searchQueries: [], rawResults: [], iteration: 0 });
    session.jobs = result.jobs;
    // merge any remaining logs
    for (const l of result.logs || []) {
      if (typeof l === "string") session.logs.push({ time: new Date().toISOString(), msg: l });
    }
    log(`Advanced crawl complete. ${session.jobs.length} curated ML jobs found.`);
  } catch (err) {
    log(`LangGraph execution error: ${err.message}`);
    session.error = err.message;
  }

  session.done = true;
}

// ─── API routes ────────────────────────────────────────────────────────────────

// Start a crawl session
app.post("/api/crawl/start", (req, res) => {
  const { mode, apiKey, model } = req.body || {};
  const sessionId = makeSession();

  if (mode === "advanced") {
    if (!apiKey) {
      return res.status(400).json({ error: "apiKey is required for advanced mode" });
    }
    runAdvancedCrawl(sessionId, apiKey, model).catch((err) => {
      crawlSessions[sessionId].error = err.message;
      crawlSessions[sessionId].done = true;
    });
  } else {
    runBasicCrawl(sessionId).catch((err) => {
      crawlSessions[sessionId].error = err.message;
      crawlSessions[sessionId].done = true;
    });
  }

  res.json({ sessionId });
});

// SSE: stream progress logs
app.get("/api/crawl/:sessionId/progress", (req, res) => {
  const { sessionId } = req.params;
  const session = crawlSessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let sentCount = 0;

  const send = () => {
    const logs = session.logs;
    while (sentCount < logs.length) {
      const entry = logs[sentCount++];
      res.write(`data: ${JSON.stringify({ type: "log", ...entry })}\n\n`);
    }
    if (session.done) {
      res.write(
        `data: ${JSON.stringify({ type: "done", jobCount: session.jobs.length, error: session.error, summary: session.summary || null })}\n\n`
      );
      clearInterval(timer);
      res.end();
    }
  };

  const timer = setInterval(send, 300);
  send();

  req.on("close", () => clearInterval(timer));
});

// Get jobs for a session
app.get("/api/crawl/:sessionId/jobs", (req, res) => {
  const { sessionId } = req.params;
  const session = crawlSessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ jobs: session.jobs, done: session.done, summary: session.summary || null });
});

app.listen(PORT, () => {
  console.log(`ML Job Crawler running on port ${PORT}`);
});
