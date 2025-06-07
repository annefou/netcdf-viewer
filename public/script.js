async loadFromURL() {
        const url = prompt('Enter Zarr URL (e.g., https://example.com/data.zarr):');
        if (!url) return;
        
        this.showLoadingOverlay(true);
        
        try {
            const response = await fetch('/api/load-url', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ url: url })
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to load from URL');
            }
            
            const result = await response.json();
            this.showStatus(`Successfully loaded Zarr from URL: ${url}`, 'success');
            console.log('Zarr metadata:', result.metadata);
            
        } catch (error) {
            this.showStatus('Failed to load from URL: ' + error.message, 'error');
            console.error('URL load error:', error);
        } finally {
            this.showLoadingOverlay(false);
        }
    }class NetCDFViewer {
    constructor() {
        this.map = null;
        this.currentLayer = null;
        this.currentData = null;
        this.currentFileId = null;
        this.colorSchemes = {
            custom: ['#193967', '#2a4d7a', '#3d638d', '#5179a0', '#6b8fb3', '#87a5c6', '#a5bbd9', '#c4d1ec', '#e6ecf5', '#f0d5e6', '#e8b5d1', '#de95bc', '#d274a7', '#c55492', '#b6357d', '#a61968', '#940053', '#81003e', '#6d0029', '#590014', '#450000'],
            temperature: ['#193967', '#2a4d7a', '#3d638d', '#5179a0', '#6b8fb3', '#87a5c6', '#a5bbd9', '#c4d1ec', '#e6ecf5', '#f0d5e6', '#e8b5d1', '#de95bc', '#d274a7', '#c55492', '#b6357d', '#a61968', '#be2e78'],
            viridis: ['#440154', '#404788', '#2a788e', '#22a884', '#7ad151', '#fde725'],
            plasma: ['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'],
            precipitation: ['#ffffff', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'],
            elevation: ['#543005', '#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#c7eae5', '#80cdc1', '#35978f', '#01665e', '#003c30']
        };
        this.init();
    }

    init() {
        this.initMap();
        this.setupEventListeners();
        this.setupDragAndDrop();
    }

    initMap() {
        this.map = L.map('map').setView([20, 0], 2);
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);
    }

    setupEventListeners() {
        // File input
        document.getElementById('fileInput').addEventListener('change', (e) => {
            if (e.target.files[0]) {
                this.uploadFile(e.target.files[0]);
            }
        });

        // Visualize button
        document.getElementById('visualizeBtn').addEventListener('click', () => {
            this.visualizeData();
        });

        // Variable selection
        document.getElementById('variableSelect').addEventListener('change', (e) => {
            document.getElementById('visualizeBtn').disabled = !e.target.value;
        });

        // Map controls
        document.getElementById('opacitySlider').addEventListener('input', (e) => {
            document.getElementById('opacityValue').textContent = e.target.value;
            this.updateLayerOpacity(parseFloat(e.target.value));
        });

        document.getElementById('colorScheme').addEventListener('change', () => {
            if (this.currentData) {
                this.updateVisualization();
            }
        });

        // Action buttons
        document.getElementById('exportBtn').addEventListener('click', () => {
            this.exportData();
        });

        document.getElementById('clearBtn').addEventListener('click', () => {
            this.clearMap();
        });
    }

    setupDragAndDrop() {
        const uploadArea = document.getElementById('uploadArea');
        
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            uploadArea.addEventListener(eventName, this.preventDefaults, false);
            document.body.addEventListener(eventName, this.preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            uploadArea.addEventListener(eventName, () => {
                uploadArea.classList.add('dragover');
            }, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            uploadArea.addEventListener(eventName, () => {
                uploadArea.classList.remove('dragover');
            }, false);
        });

        uploadArea.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                this.uploadFile(files[0]);
            }
        }, false);
    }

    preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    async uploadFile(file) {
        if (!file.name.toLowerCase().endsWith('.nc')) {
            this.showStatus('Please select a NetCDF (.nc) file', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('netcdf', file);

        // Show progress
        const progressDiv = document.getElementById('uploadProgress');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        
        progressDiv.style.display = 'block';
        progressText.textContent = 'Uploading and processing...';

        try {
            // Simulate progress for UI feedback
            let progress = 0;
            const progressInterval = setInterval(() => {
                progress += Math.random() * 20;
                if (progress > 90) progress = 90;
                progressFill.style.width = progress + '%';
            }, 200);

            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            clearInterval(progressInterval);
            progressFill.style.width = '100%';

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Upload failed');
            }

            const result = await response.json();
            this.currentFileId = result.fileId;
            
            this.displayFileInfo(result);
            this.populateVariables(result.variables);
            
            progressDiv.style.display = 'none';
            this.showStatus('File uploaded and processed successfully!', 'success');

        } catch (error) {
            progressDiv.style.display = 'none';
            this.showStatus('Upload failed: ' + error.message, 'error');
            console.error('Upload error:', error);
        }
    }

    displayFileInfo(fileInfo) {
        // Basic file info
        document.getElementById('fileName').textContent = fileInfo.filename;
        document.getElementById('fileSize').textContent = this.formatFileSize(fileInfo.size);
        document.getElementById('fileDimensions').textContent = 
            fileInfo.dimensions.map(d => `${d.name}: ${d.size}`).join(', ');
        document.getElementById('fileVariables').textContent = fileInfo.variables.length;

        // Coordinate info
        if (fileInfo.coordinates) {
            const coords = fileInfo.coordinates;
            document.getElementById('latRange').textContent = 
                `${coords.latitude.range[0].toFixed(2)}° to ${coords.latitude.range[1].toFixed(2)}°`;
            document.getElementById('lonRange').textContent = 
                `${coords.longitude.range[0].toFixed(2)}° to ${coords.longitude.range[1].toFixed(2)}°`;
            document.getElementById('gridSize').textContent = 
                `${coords.latitude.size} × ${coords.longitude.size}`;
            
            const latRes = Math.abs(coords.latitude.range[1] - coords.latitude.range[0]) / coords.latitude.size;
            const lonRes = Math.abs(coords.longitude.range[1] - coords.longitude.range[0]) / coords.longitude.size;
            document.getElementById('resolution').textContent = 
                `${latRes.toFixed(3)}° × ${lonRes.toFixed(3)}°`;
        }

        document.getElementById('fileInfoSection').style.display = 'block';
    }

    populateVariables(variables) {
        const select = document.getElementById('variableSelect');
        select.innerHTML = '<option value="">Choose a variable...</option>';
        
        // Filter for variables with at least 2 dimensions (likely geographic data)
        const geoVariables = variables.filter(v => v.shape && v.shape.length >= 2);
        
        geoVariables.forEach(variable => {
            const option = document.createElement('option');
            option.value = variable.name;
            
            const shapeStr = variable.shape ? `[${variable.shape.join(', ')}]` : '';
            const dtypeStr = variable.dtype || '';
            
            option.textContent = `${variable.name} ${shapeStr} (${dtypeStr})`;
            select.appendChild(option);
        });

        // Auto-select if there's a temperature variable
        const tempVar = geoVariables.find(v => 
            v.name.toLowerCase().includes('temp') || 
            v.name.toLowerCase().includes('t2m') ||
            v.name.toLowerCase().includes('temperature')
        );
        
        if (tempVar) {
            select.value = tempVar.name;
            document.getElementById('visualizeBtn').disabled = false;
        }
    }

    async visualizeData() {
        const variableName = document.getElementById('variableSelect').value;
        const maxPoints = document.getElementById('maxPoints').value;
        
        if (!variableName || !this.currentFileId) return;

        this.showLoadingOverlay(true);
        
        try {
            const response = await fetch(`/api/data/${this.currentFileId}/${variableName}?maxPoints=${maxPoints}`);
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to get data');
            }

            const result = await response.json();
            this.currentData = result;
            
            this.createDataVisualization(result);
            this.updateLegend(result);
            
            document.getElementById('mapSection').style.display = 'block';
            this.showStatus(`Visualized ${result.data.length.toLocaleString()} data points`, 'success');
            
        } catch (error) {
            this.showStatus('Visualization failed: ' + error.message, 'error');
            console.error('Visualization error:', error);
        } finally {
            this.showLoadingOverlay(false);
        }
    }

    createDataVisualization(data) {
        // Remove existing layer
        if (this.currentLayer) {
            this.map.removeLayer(this.currentLayer);
        }

        const colorScheme = document.getElementById('colorScheme').value;
        const colors = this.colorSchemes[colorScheme];
        const opacity = parseFloat(document.getElementById('opacitySlider').value);
        
        const { min, max } = data.statistics;
        
        // Create layer group
        this.currentLayer = L.layerGroup();
        
        // Determine point size based on data density
        const pointSize = Math.max(0.1, Math.min(2, 50000 / data.data.length));
        
        // Add data points
        data.data.forEach(point => {
            const color = this.interpolateColor(point.value, min, max, colors);
            
            // Create circle marker for better performance with large datasets
            const marker = L.circleMarker([point.lat, point.lon], {
                color: color,
                fillColor: color,
                fillOpacity: opacity,
                radius: pointSize,
                weight: 0
            });
            
            // Add popup with data info
            const variableInfo = data.variable;
            const variableName = variableInfo.name || 'Data';
            const dtype = variableInfo.dtype || '';
            
            marker.bindPopup(`
                <div style="font-family: system-ui; padding: 5px;">
                    <strong>${variableName}</strong><br>
                    <strong>Value:</strong> ${point.value.toFixed(3)} ${dtype ? '(' + dtype + ')' : ''}<br>
                    <strong>Location:</strong> ${point.lat.toFixed(3)}°, ${point.lon.toFixed(3)}°
                </div>
            `);
            
            this.currentLayer.addLayer(marker);
        });
        
        this.currentLayer.addTo(this.map);
        
        // Fit map to data bounds
        if (data.data.length > 0) {
            const lats = data.data.map(d => d.lat);
            const lons = data.data.map(d => d.lon);
            const bounds = [
                [Math.min(...lats), Math.min(...lons)],
                [Math.max(...lats), Math.max(...lons)]
            ];
            this.map.fitBounds(bounds, { padding: [10, 10] });
        }
    }

    updateVisualization() {
        if (this.currentData) {
            this.createDataVisualization(this.currentData);
        }
    }

    interpolateColor(value, min, max, colors) {
        const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
        const index = Math.floor(normalized * (colors.length - 1));
        const nextIndex = Math.min(index + 1, colors.length - 1);
        const t = (normalized * (colors.length - 1)) - index;
        
        if (index === nextIndex) return colors[index];
        return this.blendColors(colors[index], colors[nextIndex], t);
    }

    blendColors(color1, color2, t) {
        const hex1 = color1.replace('#', '');
        const hex2 = color2.replace('#', '');
        
        const r1 = parseInt(hex1.substr(0, 2), 16);
        const g1 = parseInt(hex1.substr(2, 2), 16);
        const b1 = parseInt(hex1.substr(4, 2), 16);
        
        const r2 = parseInt(hex2.substr(0, 2), 16);
        const g2 = parseInt(hex2.substr(2, 2), 16);
        const b2 = parseInt(hex2.substr(4, 2), 16);
        
        const r = Math.round(r1 + (r2 - r1) * t);
        const g = Math.round(g1 + (g2 - g1) * t);
        const b = Math.round(b1 + (b2 - b1) * t);
        
        return `rgb(${r}, ${g}, ${b})`;
    }

    updateLayerOpacity(opacity) {
        if (this.currentLayer) {
            this.currentLayer.eachLayer(layer => {
                layer.setStyle({ fillOpacity: opacity });
            });
        }
    }

    updateLegend(data) {
        const colorScheme = document.getElementById('colorScheme').value;
        const colors = this.colorSchemes[colorScheme];
        const stats = data.statistics;
        const variableInfo = data.variable;
        
        // Create title from variable info
        let title = variableInfo.name;
        if (variableInfo.dtype) {
            title += ` (${variableInfo.dtype})`;
        }
        
        // Update legend title
        document.getElementById('legendTitle').textContent = title;
        
        // Update color scale
        const colorScale = document.getElementById('colorScale');
        colorScale.innerHTML = '';
        colors.forEach(color => {
            const segment = document.createElement('div');
            segment.style.flex = '1';
            segment.style.backgroundColor = color;
            colorScale.appendChild(segment);
        });
        
        // Update scale labels
        const scaleLabels = document.getElementById('scaleLabels');
        scaleLabels.innerHTML = `
            <span>${stats.min.toFixed(2)}</span>
            <span>${stats.mean.toFixed(2)}</span>
            <span>${stats.max.toFixed(2)}</span>
        `;
        
        // Update statistics
        const legendStats = document.getElementById('legendStats');
        legendStats.innerHTML = `
            <div>
                <div class="stat-label">Minimum</div>
                <div class="stat-value">${stats.min.toFixed(2)}</div>
            </div>
            <div>
                <div class="stat-label">Maximum</div>
                <div class="stat-value">${stats.max.toFixed(2)}</div>
            </div>
            <div>
                <div class="stat-label">Mean</div>
                <div class="stat-value">${stats.mean.toFixed(2)}</div>
            </div>
            <div>
                <div class="stat-label">Points</div>
                <div class="stat-value">${stats.count.toLocaleString()}</div>
            </div>
        `;
        
        document.getElementById('legend').style.display = 'block';
    }

    exportData() {
        if (!this.currentData) {
            this.showStatus('No data to export', 'warning');
            return;
        }

        const data = this.currentData;
        const csvContent = [
            'latitude,longitude,value',
            ...data.data.map(d => `${d.lat},${d.lon},${d.value}`)
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `${data.variable.name}_data.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.showStatus('Data exported successfully!', 'success');
    }

    clearMap() {
        if (this.currentLayer) {
            this.map.removeLayer(this.currentLayer);
            this.currentLayer = null;
        }
        this.currentData = null;
        document.getElementById('legend').style.display = 'none';
        this.showStatus('Map cleared', 'success');
    }

    showLoadingOverlay(show) {
        document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
    }

    showStatus(message, type = 'info') {
        const container = document.getElementById('statusContainer');
        
        const statusDiv = document.createElement('div');
        statusDiv.className = `status-message ${type}`;
        
        const icons = {
            success: '✅',
            error: '❌',
            warning: '⚠️',
            info: 'ℹ️'
        };
        
        statusDiv.innerHTML = `
            <span>${icons[type] || icons.info}</span>
            <span>${message}</span>
        `;
        
        container.appendChild(statusDiv);
        
        // Auto-remove after delay
        setTimeout(() => {
            if (statusDiv.parentNode) {
                statusDiv.parentNode.removeChild(statusDiv);
            }
        }, type === 'error' ? 8000 : 5000);
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    new NetCDFViewer();
});
