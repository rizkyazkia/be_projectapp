import { Router } from "express";
import {
  createClasses,
  getClasses,
  deleteClasses,
  updateClasses,
  getClassesByInstitution
} from "../controllers/ClassesController.js";
import { verifyToken } from "../middelware/verifyToken.js";

const router = Router();

router.get("/classes/institution/:institutionId", getClassesByInstitution);
router.get("/classes", verifyToken, getClasses);
router.post("/classes", verifyToken, createClasses);
router.put("/classes/:id", verifyToken, updateClasses);
router.delete("/classes/:id", verifyToken, deleteClasses);

export default router;
