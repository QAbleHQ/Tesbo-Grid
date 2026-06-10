import { Router } from "express";
import { getQueueStats } from "../services/queueService.js";
import { currentMetrics, autoscaleRecommendation, startupLagSnapshot } from "../services/metricsService.js";
import { apiKeyAuth } from "../middleware/auth.js";

const router = Router();

router.get("/stats", apiKeyAuth("queue:read"), async (_req, res) => {
  try {
    const [queueStats, dbMetrics, recommendation, startupLag] = await Promise.all([
      getQueueStats(),
      currentMetrics(),
      autoscaleRecommendation(),
      startupLagSnapshot(),
    ]);
    res.json({ ...queueStats, ...dbMetrics, ...recommendation, ...startupLag });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to get queue stats" });
  }
});

router.get("/autoscaling", apiKeyAuth("queue:read"), async (_req, res) => {
  try {
    const recommendation = await autoscaleRecommendation();
    res.json(recommendation);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to get autoscaling recommendation" });
  }
});

export default router;
