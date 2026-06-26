fetch('/api/v1/reports');
fetch('/graphql', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ operationName: 'GetReports', query: 'query GetReports { reports { id } }' }) });
