import { defineCeoPlannerContractTests } from "./ceo-planner-contract.js";
import { createScriptedCeoPlanner } from "./scripted-ceo-planner.js";

defineCeoPlannerContractTests("scripted test planner", createScriptedCeoPlanner);
