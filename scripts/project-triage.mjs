// scripts/project-triage.mjs
// Auto-add an issue to the pi-live GitHub Projects v2 board and sync its
// `Priority` single-select field from the issue's P0/P1/P2 label.
//
// Env:
//   GH_TOKEN        - a PAT (or GitHub App token) with project + repo scope
//   PROJECT_LOGIN   - owner of the project (e.g. "BlockedPath")
//   PROJECT_NUMBER  - project number (e.g. 6)
//   ISSUE_NODE_ID   - global node id of the issue
//   ISSUE_NUMBER    - issue number (used for the idempotency lookup)
//   LABELS          - JSON array of label names on the issue

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

function gql(query, variables) {
	return fetch(GITHUB_GRAPHQL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.GH_TOKEN}`,
			"Content-Type": "application/json",
			"User-Agent": "pi-live-project-triage",
		},
		body: JSON.stringify({ query, variables }),
	}).then((r) => r.json());
}

function priorityFromLabels(labels) {
	// Highest priority wins if multiple are present.
	for (const p of ["P0", "P1", "P2"]) {
		if (labels.includes(p)) return p;
	}
	return null; // none -> clear the field
}

async function getProject() {
	const res = await gql(
		`query($login: String!, $number: Int!) {
       user(login: $login) {
         projectV2(number: $number) {
           id
           fields(first: 100) {
             nodes {
               ... on ProjectV2SingleSelectField { id name options { id name } }
             }
           }
         }
       }
     }`,
		{
			login: process.env.PROJECT_LOGIN,
			number: Number(process.env.PROJECT_NUMBER),
		},
	);
	const proj = res.data?.user?.projectV2;
	if (!proj) throw new Error(`Could not load project: ${JSON.stringify(res)}`);
	return proj;
}

async function findExistingItem(projectId, issueNumber) {
	// Page through items to find one whose content matches this issue number.
	let cursor = null;
	for (let i = 0; i < 10; i++) {
		const res = await gql(
			`query($projectId: ID!, $cursor: String) {
         node(id: $projectId) {
           ... on ProjectV2 {
             items(first: 100, after: $cursor) {
               pageInfo { hasNextPage endCursor }
               nodes {
                 id
                 content { ... on Issue { number } }
               }
             }
           }
         }
       }`,
			{ projectId, cursor },
		);
		const items = res.data?.node?.items ?? {};
		const found = (items.nodes ?? []).find(
			(n) => n.content && n.content.number === issueNumber,
		);
		if (found) return found.id;
		if (!items.pageInfo?.hasNextPage) return null;
		cursor = items.pageInfo.endCursor;
	}
	return null;
}

async function addItem(projectId, issueNodeId) {
	const res = await gql(
		`mutation($input: AddProjectV2ItemByIdInput!) {
       addProjectV2ItemById(input: $input) { item { id } }
     }`,
		{ input: { projectId, contentId: issueNodeId } },
	);
	if (res.errors)
		throw new Error(
			`addProjectV2ItemById failed: ${JSON.stringify(res.errors)}`,
		);
	return res.data.addProjectV2ItemById.item.id;
}

async function setPriority(projectId, itemId, fieldId, optionId) {
	// Empty string clears a single-select field.
	const value = { singleSelectOptionId: optionId ?? "" };
	const res = await gql(
		`mutation($input: UpdateProjectV2ItemFieldValueInput!) {
       updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
     }`,
		{ input: { projectId, itemId, fieldId, value } },
	);
	if (res.errors)
		throw new Error(
			`updateProjectV2ItemFieldValue failed: ${JSON.stringify(res.errors)}`,
		);
}

async function main() {
	let labels;
	try {
		labels = JSON.parse(process.env.LABELS || "[]");
	} catch {
		labels = [];
	}
	const issueNumber = Number(process.env.ISSUE_NUMBER);
	const issueNodeId = process.env.ISSUE_NODE_ID;

	console.log(`Issue #${issueNumber} labels: ${JSON.stringify(labels)}`);

	const proj = await getProject();
	const projectId = proj.id;
	const priorityField = proj.fields.nodes.find(
		(f) => f.name === "Priority" && f.options,
	);
	if (!priorityField)
		throw new Error('Project has no single-select "Priority" field');
	const optionByName = Object.fromEntries(
		priorityField.options.map((o) => [o.name, o.id]),
	);

	let itemId = await findExistingItem(projectId, issueNumber);
	if (itemId) {
		console.log(`Already in project (item ${itemId}); syncing priority.`);
	} else {
		itemId = await addItem(projectId, issueNodeId);
		console.log(`Added to project (item ${itemId}).`);
	}

	const priority = priorityFromLabels(labels);
	if (priority) {
		const optionId = optionByName[priority];
		if (!optionId) throw new Error(`No Priority option named "${priority}"`);
		await setPriority(projectId, itemId, priorityField.id, optionId);
		console.log(`Set Priority = ${priority}.`);
	} else {
		await setPriority(projectId, itemId, priorityField.id, null);
		console.log("No P0/P1/P2 label; cleared Priority.");
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
