export type GutoTeamPlan = "start" | "pro" | "elite" | "custom";

export const GUTO_TEAM_PLAN_LIMITS = {
    start: {
        label: "GUTO Time Start",
        maxCoaches: 2,
        maxStudents: 20,
    },
    pro: {
        label: "GUTO Time Pro",
        maxCoaches: 4,
        maxStudents: 50,
    },
    elite: {
        label: "GUTO Time Elite",
        maxCoaches: 6,
        maxStudents: 70,
    },
    custom: {
        label: "GUTO Time Custom",
        maxCoaches: null,
        maxStudents: null,
    },
} as const;