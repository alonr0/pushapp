// netlify/functions/send-push.js

exports.handler = async (event, context) => {
    // Only allow secure POST requests from your app to avoid random link pings
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }
  
    try {
      // Extract user tracking data sent from your frontend React app
      const { username, repsCount, groupName, currentGroupId } = JSON.parse(event.body);
  
      const appId = process.env.VITE_ONESIGNAL_APP_ID;
      const restApiKey = process.env.VITE_ONESIGNAL_REST_API_KEY;
  
      // Fire the secure server-to-server request directly to OneSignal
      const response = await fetch("https://api.onesignal.com/notifications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${restApiKey}` // Safely authorized in the cloud!
        },
        body: JSON.stringify({
          app_id: appId,
          headings: { en: "PushApp Alert! 🔥" },
          contents: { en: `${username} just logged ${repsCount} pushups in ${groupName}!` },
          // Target only friends subscribed with a matching Firestore Group ID tag
          filters: [
            { field: "tag", key: "groupId", relation: "=", value: currentGroupId }
          ]
        })
      });
  
      const data = await response.json();
  
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, data })
      };
    } catch (error) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message })
      };
    }
  };