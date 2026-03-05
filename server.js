data.history.forEach((event, index) => {
                  let dateStr = event.date;
                  let timeStr = '';
                  
                  // Smarter Date Parsing
                  try {
                    let safeDate = event.date;
                    // Only apply Safari slash fix if it's a space-separated SQL date, NOT an ISO date
                    if (safeDate.includes(' ') && !safeDate.includes('T')) {
                        safeDate = safeDate.replace(/-/g, '/');
                    }
                    const d = new Date(safeDate);
                    
                    // If the date is valid, format it!
                    if (!isNaN(d.getTime())) {
                      dateStr = d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
                      timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                    }
                  } catch(e) {}

                  // Visuals: Make the top connecting line match the courier color
                  const lineStyle = index === 0 ? `background: var(--courier-color);` : `background: #ccc;`;
                  
                  // Hide the line for the very last item in the list
                  const lineHTML = index === (data.history.length - 1) 
                    ? `<div class="journey-line" style="${lineStyle}; display: none;"></div>` 
                    : `<div class="journey-line" style="${lineStyle}"></div>`;

                  if (dateStr !== currentDate) {
                    timelineHtml += `<div class="journey-date-header">${dateStr}</div>`;
                    currentDate = dateStr;
                  }

                  timelineHtml += `
                    <div class="journey-item">
                      <div class="journey-time">${timeStr}</div>
                      <div class="journey-line-container">
                         ${lineHTML}
                      </div>
                      <div class="journey-details">
                        <div class="journey-status">${event.detail}</div>
                        ${event.location ? `<div class="journey-location">${event.location}</div>` : ''}
                      </div>
                    </div>
                  `;
                });
