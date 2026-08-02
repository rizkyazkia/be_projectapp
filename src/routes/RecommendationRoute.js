import { Router } from "express";
import {
  changeStatusToProcessed,
  createRecommendation,
  getRecomendations,
  getResponseInstitution,
  getResponseParent,
  createIntervention,
  getSingleRecommendation,
  getInterventionsBelongToInstitution,
  getInterventionsBelongToFamily,
  getInterventionById,
  deleteIntervention,
} from "../controllers/RecommendationController.js";
import { verifyToken } from "../middelware/verifyToken.js";

const router = Router();

router.get("/recommendation", verifyToken, getRecomendations);
router.get("/recommendation/single/:id", getSingleRecommendation);
router.get("/recommendation/:id", getResponseParent);
router.get("/recommendation/institution/:id", getResponseInstitution);
router.post("/recommendation/user", verifyToken, createRecommendation);
router.patch("/recommendation/:id", changeStatusToProcessed);
router.post(
  "/recommendation/:id/interventions",
  verifyToken,
  createIntervention
);

// INTERVENTIONS
router.get(
  "/interventions/institutions",
  verifyToken,
  getInterventionsBelongToInstitution
);
router.get(
  "/interventions/families",
  verifyToken,
  getInterventionsBelongToFamily
);
router.get("/interventions/:id", getInterventionById);
router.delete("/interventions/:id", deleteIntervention);

export default router;
