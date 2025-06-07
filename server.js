const express = require('express');
const cors = require('cors');
const multer = require('multer');
const netcdf4 = require('netcdf4');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({limit: '500mb'}));
app.use(express.urlencoded({limit: '500mb', extended: true}));
app.use(express.static('public'));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

// In-memory cache for processed data
const dataCache = new Map();

// Helper function to sample data for performance
function sampleData(data, latData, lonData, maxPoints = 50000) {
  const totalPoints = latData.length * lonData.length;
  const sampleRate = Math.max(1, Math.ceil(totalPoints / maxPoints));
  
  const sampledData = [];
  const sampledLats = [];
  const sampledLons = [];
  
  for (let i = 0; i < latData.length; i += sampleRate) {
    sampledLats.push(latData[i]);
    for (let j = 0; j < lonData.length; j += sampleRate) {
      if (i === 0) sampledLons.push(lonData[j]);
      
      const dataIndex = i * lonData.length + j;
      const value = data[dataIndex];
      
      // Filter out invalid values
      if (value !== null && !isNaN(value) && Math.abs(value) < 1e30) {
        sampledData.push({
          lat: latData[i],
          lon: lonData[j],
          value: value
        });
      }
    }
  }
  
  return {
    data: sampledData,
    latData: sampledLats,
    lonData: sampledLons,
    sampleRate: sampleRate
  };
}

// Helper function to find coordinate variables
function findCoordinateVariables(file) {
  const variables = Object.keys(file.root.variables);
  
  const latVar = variables.find(name => 
    name.toLowerCase().includes('lat') || 
    name.toLowerCase() === 'y' ||
    (file.root.variables[name].attributes && 
     file.root.variables[name].attributes.standard_name === 'latitude')
  );
  
  const lonVar = variables.find(name => 
    name.toLowerCase().includes('lon') || 
    name.toLowerCase() === 'x' ||
    (file.root.variables[name].attributes && 
     file.root.variables[name].attributes.standard_name === 'longitude')
  );
  
  return { latVar, lonVar };
}

// API Routes

// Upload and analyze netCDF file
app.post('/api/upload', upload.single('netcdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    
    // Open NetCDF4 file
    const file = new netcdf4.File(filePath, 'r');
    
    // Extract file information
    const dimensions = Object.keys(file.root.dimensions).map(name => ({
      name: name,
      size: file.root.dimensions[name].length
    }));
    
    const variables = Object.keys(file.root.variables).map(name => {
      const variable = file.root.variables[name];
      return {
        name: name,
        dimensions: variable.dimensions.map(d => d.name),
        attributes: variable.attributes || {},
        type: variable.type
      };
    });
    
    // Find coordinate variables
    const { latVar, lonVar } = findCoordinateVariables(file);
    
    let coordinates = null;
    if (latVar && lonVar) {
      const latData = file.root.variables[latVar].read();
      const lonData = file.root.variables[lonVar].read();
      
      coordinates = {
        latitude: {
          name: latVar,
          range: [Math.min(...latData), Math.max(...latData)],
          size: latData.length
        },
        longitude: {
          name: lonVar,
          range: [Math.min(...lonData), Math.max(...lonData)],
          size: lonData.length
        }
      };
    }
    
    // Store file info in cache
    const fileId = req.file.filename;
    dataCache.set(fileId, {
      file: file,
      filePath: filePath,
      coordinates: coordinates
    });
    
    res.json({
      fileId: fileId,
      filename: req.file.originalname,
      size: req.file.size,
      dimensions: dimensions,
      variables: variables,
      coordinates: coordinates
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process netCDF file: ' + error.message });
  }
});

// Get variable data
app.get('/api/data/:fileId/:variableName', async (req, res) => {
  try {
    const { fileId, variableName } = req.params;
    const maxPoints = parseInt(req.query.maxPoints) || 50000;
    
    const cachedData = dataCache.get(fileId);
    if (!cachedData) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const { file, coordinates } = cachedData;
    
    // Check if variable exists
    if (!file.root.variables[variableName]) {
      return res.status(404).json({ error: 'Variable not found' });
    }
    
    // Get variable data
    const variable = file.root.variables[variableName];
    
    // For multi-dimensional data, we need to handle slicing
    let data;
    if (variable.dimensions.length === 3) {
      // Assume format: [time, lat, lon] - take first time slice
      data = variable.readSlice(0, null, null);
    } else if (variable.dimensions.length === 2) {
      // Format: [lat, lon]
      data = variable.read();
    } else {
      return res.status(400).json({ error: 'Unsupported variable dimensions' });
    }
    
    // Get coordinate data
    if (!coordinates) {
      return res.status(400).json({ error: 'Coordinate variables not found' });
    }
    
    const latData = file.root.variables[coordinates.latitude.name].read();
    const lonData = file.root.variables[coordinates.longitude.name].read();
    
    // Flatten the data array if it's 2D
    let flatData;
    if (Array.isArray(data[0])) {
      flatData = data.flat();
    } else {
      flatData = data;
    }
    
    // Sample data for performance
    const sampledResult = sampleData(flatData, latData, lonData, maxPoints);
    
    // Calculate statistics
    const values = sampledResult.data.map(d => d.value);
    const validValues = values.filter(v => v !== null && !isNaN(v) && isFinite(v));
    
    const stats = {
      min: Math.min(...validValues),
      max: Math.max(...validValues),
      mean: validValues.reduce((a, b) => a + b, 0) / validValues.length,
      count: validValues.length,
      totalPoints: latData.length * lonData.length,
      sampleRate: sampledResult.sampleRate
    };
    
    res.json({
      variable: {
        name: variableName,
        attributes: variable.attributes || {},
        dimensions: variable.dimensions.map(d => d.name)
      },
      data: sampledResult.data,
      coordinates: {
        latitude: sampledResult.latData,
        longitude: sampledResult.lonData
      },
      statistics: stats
    });
    
  } catch (error) {
    console.error('Data extraction error:', error);
    res.status(500).json({ error: 'Failed to extract data: ' + error.message });
  }
});

// Get variable metadata only
app.get('/api/variable/:fileId/:variableName/info', (req, res) => {
  try {
    const { fileId, variableName } = req.params;
    
    const cachedData = dataCache.get(fileId);
    if (!cachedData) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const { file } = cachedData;
    const variable = file.root.variables[variableName];
    
    if (!variable) {
      return res.status(404).json({ error: 'Variable not found' });
    }
    
    res.json({
      name: variableName,
      dimensions: variable.dimensions.map(d => d.name),
      attributes: variable.attributes || {},
      type: variable.type
    });
    
  } catch (error) {
    console.error('Variable info error:', error);
    res.status(500).json({ error: 'Failed to get variable info: ' + error.message });
  }
});

// Delete uploaded file
app.delete('/api/file/:fileId', (req, res) => {
  try {
    const { fileId } = req.params;
    
    const cachedData = dataCache.get(fileId);
    if (cachedData) {
      // Close netCDF file
      if (cachedData.file) {
        try {
          cachedData.file.close();
        } catch (e) {
          console.warn('Warning: Could not close netCDF file:', e.message);
        }
      }
      
      // Delete file from disk
      if (fs.existsSync(cachedData.filePath)) {
        fs.unlinkSync(cachedData.filePath);
      }
      
      // Remove from cache
      dataCache.delete(fileId);
    }
    
    res.json({ message: 'File deleted successfully' });
    
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete file: ' + error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    activeFiles: dataCache.size
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large' });
    }
  }
  
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🌍 NetCDF Viewer Server running on http://localhost:${PORT}`);
  console.log('📁 Upload directory: ./uploads/');
  console.log('🌐 Frontend: http://localhost:' + PORT);
  
  // Create uploads directory if it doesn't exist
  if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
    console.log('📁 Created uploads directory');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔄 Received SIGTERM, shutting down gracefully');
  
  // Clean up cache and temp files
  for (const [fileId, data] of dataCache) {
    // Close netCDF files
    if (data.file) {
      try {
        data.file.close();
      } catch (e) {
        console.warn('Warning: Could not close netCDF file:', e.message);
      }
    }
    
    // Delete temp files
    if (fs.existsSync(data.filePath)) {
      fs.unlinkSync(data.filePath);
    }
  }
  
  process.exit(0);
});
