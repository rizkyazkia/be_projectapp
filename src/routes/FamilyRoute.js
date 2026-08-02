import { Router } from "express";
import {
  createFamilyMember,
  deleteFamilyMember,
  getFamily,
  getFamilyMember,
  getFamilyMemberByUser,
  getParentsByFamilyMemberId,
  updateFamilyMember,
  addMeasurement,
  getNutritionHistory,
} from "../controllers/FamilyController.js";
import { verifyToken } from "../middelware/verifyToken.js";

const router = Router();

router.get("/family", getFamily);
router.get("/families/user", verifyToken, getFamilyMemberByUser);
router.get("/families", getFamilyMember);
router.get("/families/:id/parents", getParentsByFamilyMemberId);
router.post("/families/user", verifyToken, createFamilyMember);
router.put("/families/:id", updateFamilyMember);
router.delete("/families/:id", deleteFamilyMember);
router.post("/families/:id/measurements", verifyToken, addMeasurement);
router.get("/families/:id/nutrition-history", verifyToken, getNutritionHistory);

export default router;
