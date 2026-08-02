import { Router } from "express";
import {
  createTeacher,
  deleteTeacher,
  getTeachers,
  updateTeacher,
} from "../controllers/TeacherController.js";
import { verifyToken } from "../middelware/verifyToken.js";

const router = Router();

router.get("/teachers", verifyToken, getTeachers);
router.post("/teachers", verifyToken, createTeacher);
router.put("/teachers/:id", verifyToken, updateTeacher);
router.delete("/teachers/:id", verifyToken, deleteTeacher);

export default router;
