const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { openArray, slice } = require('zarr');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true}));
app.use(express.static('public'));

// Configure multer for Zarr file uploads (supports .zarr directories)
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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit for Zarr archives
  fileFilter: (req, file, cb) => {
    // Accept .zarr files (usually zip archives) and .zip files
    if (file.mimetype === 'application/zip' || 
        file.originalname.endsWith('.zarr') || 
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only .zarr or .zip files are allowed'));
    }
  }
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
      if (dataIndex < data.length) {
        const value = data[dataIndex];
        
        // Filter out invalid values
        if (value !== null && !isNaN(value) && isFinite(value)) {
          sampledData.push({
            lat: latData[i],
            lon: lonData[j],
            value: value
          });
        }
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

// Helper function to extract Zarr archive
async function extractZarrArchive(filePath, extractPath) {
  const AdmZip = require('adm-zip');
  try {
    const zip = new AdmZip(filePath);
    zip.extractAllTo(extractPath, true);
    return extractPath;
  } catch (error) {
    throw new Error('Failed to extract Zarr archive: ' + error.message);
  }
}

// Helper function to find coordinate arrays in Zarr
async function findCoordinateArrays(zarrPath) {
  try {
    // Common coordinate variable names
    const coordNames = ['latitude', 'lat', 'longitude', 'lon', 'x', 'y'];
    const coordinates = {};
    
    for (const name of coordNames) {
      try {
        const coordPath = path.join(zarrPath, name);
        if (fs.existsSync(coordPath)) {
          const coordArray = await openArray(coordPath);
          if (name.toLowerCase().includes('lat') || name.toLowerCase() === 'y') {
            coordinates.latitude = { name, array: coordArray };
          } else if (name.toLowerCase().includes('lon') || name.toLowerCase() === 'x') {
            coordinates.longitude = { name, array: coordArray };
          }
        }
      } catch (e) {
        // Continue searching if this coordinate doesn't exist
        continue;
      }
    }
    
    return coordinates;
  } catch (error) {
    throw new Error('Failed to find coordinate arrays: ' + error.message);
  }
}

// Upload and analyze Zarr file
app.post('/api/upload', upload.single('zarr'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const fileId = req.file.filename;
    const extractPath = path.join('uploads', `extracted_${fileId}`);
    
    // Extract Zarr archive if it's zipped
    let zarrPath;
    if (req.file.originalname.endsWith('.zip') || req.file.originalname.endsWith('.zarr')) {
      zarrPath = await extractZarrArchive(filePath, extractPath);
      
      // Find the actual Zarr directory inside the extracted folder
      const files = fs.readdirSync(zarrPath);
      const zarrDir = files.find(f => f.endsWith('.zarr') || fs.statSync(path.join(zarrPath, f)).isDirectory());
      if (zarrDir) {
        zarrPath = path.join(zarrPath, zarrDir);
      }
    } else {
      zarrPath = filePath;
    }

    // Find coordinate arrays
    const coordinates = await findCoordinateArrays(zarrPath);
    
    // Get dimensions and variables by exploring the Zarr structure
    const zarrContents = fs.readdirSync(zarrPath);
    const variables = [];
    const dimensions = [];
    
    for (const item of zarrContents) {
      const itemPath = path.join(zarrPath, item);
      if (fs.statSync(itemPath).isDirectory() && !item.startsWith('.')) {
        try {
          const array = await openArray(itemPath);
          const meta = array.meta;
          
          variables.push({
            name: item,
            shape: meta.shape,
            dtype: meta.dtype,
            chunks: meta.chunks,
            dimensions: meta.shape.map((size, idx) => `dim_${idx}`)
          });
          
          // Add dimensions
          meta.shape.forEach((size, idx) => {
            const dimName = `dim_${idx}`;
            if (!dimensions.find(d => d.name === dimName)) {
              dimensions.push({ name: dimName, size });
            }
          });
        } catch (e) {
          // Skip non-array directories
          continue;
        }
      }
    }
    
    // Get coordinate data if available
    let coordinateInfo = null;
    if (coordinates.latitude && coordinates.longitude) {
      const latData = await coordinates.latitude.array.get();
      const lonData = await coordinates.longitude.array.get();
      
      coordinateInfo = {
        latitude: {
          name: coordinates.latitude.name,
          range: [Math.min(...latData), Math.max(...latData)],
          size: latData.length
        },
        longitude: {
          name: coordinates.longitude.name,
          range: [Math.min(...lonData), Math.max(...lonData)],
          size: lonData.length
        }
      };
    }
    
    // Store file info in cache
    dataCache.set(fileId, {
      zarrPath: zarrPath,
      filePath: filePath,
      extractPath: extractPath,
      coordinates: coordinates,
      coordinateInfo: coordinateInfo
    });
    
    res.json({
      fileId: fileId,
      filename: req.file.originalname,
      size: req.file.size,
      dimensions: dimensions,
      variables: variables,
      coordinates: coordinateInfo,
      format: 'Zarr'
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process Zarr file: ' + error.message });
  }
});

// Get variable data from Zarr
app.get('/api/data/:fileId/:variableName', async (req, res) => {
  try {
    const { fileId, variableName } = req.params;
    const maxPoints = parseInt(req.query.maxPoints) || 50000;
    
    const cachedData = dataCache.get(fileId);
    if (!cachedData) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const { zarrPath, coordinates, coordinateInfo } = cachedData;
    
    // Open the variable array
    const variablePath = path.join(zarrPath, variableName);
    if (!fs.existsSync(variablePath)) {
      return res.status(404).json({ error: 'Variable not found' });
    }
    
    const dataArray = await openArray(variablePath);
    const meta = dataArray.meta;
    
    // Get coordinate data
    if (!coordinates.latitude || !coordinates.longitude) {
      return res.status(400).json({ error: 'Coordinate arrays not found' });
    }
    
    const latData = await coordinates.latitude.array.get();
    const lonData = await coordinates.longitude.array.get();
    
    // Handle multi-dimensional data (take first time slice if needed)
    let data;
    if (meta.shape.length === 3) {
      // Assume [time, lat, lon] format - take first time slice
      data = await dataArray.get([0, slice(null), slice(null)]);
      data = data.flat(); // Flatten 2D array to 1D
    } else if (meta.shape.length === 2) {
      // [lat, lon] format
      data = await dataArray.get();
      data = data.flat(); // Flatten 2D array to 1D
    } else {
      return res.status(400).json({ error: 'Unsupported data dimensions' });
    }
    
    // Sample data for performance
    const sampledResult = sampleData(data, latData, lonData, maxPoints);
    
    // Calculate statistics
    const values = sampledResult.data.map(d => d.value);
    const validValues = values.filter(v => v !== null && !isNaN(v) && isFinite(v));
    
    if (validValues.length === 0) {
      return res.status(400).json({ error: 'No valid data points found' });
    }
    
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
        shape: meta.shape,
        dtype: meta.dtype,
        chunks: meta.chunks
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

// Load Zarr from URL (for cloud-hosted data)
app.post('/api/load-url', async (req, res) => {
  try {
    const { url, variable } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    // Open Zarr array from URL
    const dataArray = await openArray(url);
    const meta = dataArray.meta;
    
    // For demo, get a small chunk
    const chunkSize = 100;
    const data = await dataArray.get([
      slice(0, 1), // First time slice if 3D
      slice(0, chunkSize), 
      slice(0, chunkSize)
    ]);
    
    res.json({
      metadata: meta,
      sampleData: data,
      message: 'Successfully loaded Zarr from URL'
    });
    
  } catch (error) {
    console.error('URL load error:', error);
    res.status(500).json({ error: 'Failed to load Zarr from URL: ' + error.message });
  }
});

// Delete uploaded files
app.delete('/api/file/:fileId', (req, res) => {
  try {
    const { fileId } = req.params;
    
    const cachedData = dataCache.get(fileId);
    if (cachedData) {
      // Delete original file
      if (fs.existsSync(cachedData.filePath)) {
        fs.unlinkSync(cachedData.filePath);
      }
      
      // Delete extracted directory
      if (cachedData.extractPath && fs.existsSync(cachedData.extractPath)) {
        fs.rmSync(cachedData.extractPath, { recursive: true, force: true });
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
    activeFiles: dataCache.size,
    version: 'Zarr-powered'
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌍 NetCDF Viewer Server (Zarr-powered) running on port ${PORT}`);
  console.log('📁 Upload directory: ./uploads/');
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('⚡ Zarr format supported for high-performance data loading');
  
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
    // Delete temp files
    if (fs.existsSync(data.filePath)) {
      fs.unlinkSync(data.filePath);
    }
    
    // Delete extracted directories
    if (data.extractPath && fs.existsSync(data.extractPath)) {
      fs.rmSync(data.extractPath, { recursive: true, force: true });
    }
  }
  
  process.exit(0);
});
