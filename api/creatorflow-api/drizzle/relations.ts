import { relations } from "drizzle-orm/relations";
import { splitExecuted, recipientPayout } from "./schema";

export const recipientPayoutRelations = relations(recipientPayout, ({one}) => ({
	splitExecuted: one(splitExecuted, {
		fields: [recipientPayout.txDigest],
		references: [splitExecuted.txDigest]
	}),
}));

export const splitExecutedRelations = relations(splitExecuted, ({many}) => ({
	recipientPayouts: many(recipientPayout),
}));