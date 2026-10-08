# BloodReport AI

An AI-powered blood test analysis platform that allows users to upload blood test reports, extract laboratory values, compare them with appropriate reference ranges, compare current results with previous reports, visualize changes through interactive Chart.js graphs, and receive simple educational explanations.

> **Important Medical Disclaimer:**  
> AI-generated information is for educational purposes only and does not replace professional medical advice.


### How to Run
1. Make sure your `.env` file has your `GEMINI_API_KEY`:
   ```env
   GEMINI_API_KEY=your_actual_key_here
   ```
2. Start the Python Flask backend:
   ```bash
   pip install -r backend/requirements.txt
   python backend/app.py
   ```
3. Open your browser to `http://localhost:5000` to access the full application with server-side AI processing.
4. *(Note: You can also open `index.html` directly for client preview with local rule-based parsing).*
