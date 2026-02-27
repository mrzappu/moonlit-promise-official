// Add to cart functionality
function addToCart(productId) {
    const quantity = document.getElementById('quantity')?.value || 1;
    
    fetch(`/cart/add/${productId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ quantity })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showNotification('Item added to cart!', 'success');
            updateCartCount();
        } else {
            showNotification(data.error || 'Failed to add item', 'error');
        }
    })
    .catch(err => {
        console.error('Error:', err);
        showNotification('An error occurred', 'error');
    });
}

// Remove from cart
function removeFromCart(cartId) {
    if (!confirm('Remove this item from cart?')) return;
    
    fetch(`/cart/remove/${cartId}`, {
        method: 'POST'
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            location.reload();
        } else {
            showNotification(data.error || 'Failed to remove item', 'error');
        }
    })
    .catch(err => {
        console.error('Error:', err);
        showNotification('An error occurred', 'error');
    });
}

// Update cart count
function updateCartCount() {
    fetch('/cart/count')
        .then(res => res.json())
        .then(data => {
            const cartBadge = document.getElementById('cart-count');
            if (cartBadge) {
                cartBadge.textContent = data.count;
                cartBadge.style.display = data.count > 0 ? 'inline' : 'none';
            }
        })
        .catch(err => console.error('Error updating cart count:', err));
}

// Show notification
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `alert alert-${type}`;
    notification.style.position = 'fixed';
    notification.style.top = '20px';
    notification.style.right = '20px';
    notification.style.zIndex = '9999';
    notification.style.minWidth = '300px';
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// Search products
let searchTimeout;
function searchProducts(query) {
    clearTimeout(searchTimeout);
    
    searchTimeout = setTimeout(() => {
        if (query.length < 2) return;
        
        fetch(`/api/search?q=${encodeURIComponent(query)}`)
            .then(res => res.json())
            .then(products => {
                displaySearchResults(products);
            })
            .catch(err => console.error('Search error:', err));
    }, 300);
}

// Display search results
function displaySearchResults(products) {
    const resultsDiv = document.getElementById('search-results');
    if (!resultsDiv) return;
    
    if (products.length === 0) {
        resultsDiv.innerHTML = '<p class="text-center">No products found</p>';
        return;
    }
    
    let html = '<div class="row">';
    products.forEach(product => {
        html += `
            <div class="col-md-4 mb-3">
                <div class="card">
                    <img src="${product.image_url}" class="card-img-top" alt="${product.name}">
                    <div class="card-body">
                        <h5 class="card-title">${product.name}</h5>
                        <p class="card-text">₹${product.price}</p>
                        <a href="/product/${product.id}" class="btn btn-primary btn-sm">View</a>
                    </div>
                </div>
            </div>
        `;
    });
    html += '</div>';
    
    resultsDiv.innerHTML = html;
}

// Filter products
function filterProducts() {
    const form = document.getElementById('filter-form');
    const formData = new FormData(form);
    const params = new URLSearchParams(formData).toString();
    
    window.location.href = `/shop?${params}`;
}

// Load more products (infinite scroll)
let page = 1;
let loading = false;
let hasMore = true;

window.addEventListener('scroll', () => {
    if (!hasMore || loading) return;
    
    const scrollPosition = window.innerHeight + window.scrollY;
    const documentHeight = document.documentElement.scrollHeight;
    
    if (scrollPosition >= documentHeight - 500) {
        loadMoreProducts();
    }
});

function loadMoreProducts() {
    loading = true;
    document.getElementById('loading-spinner').style.display = 'block';
    
    page++;
    
    fetch(`/api/products?page=${page}`)
        .then(res => res.json())
        .then(data => {
            if (data.products.length === 0) {
                hasMore = false;
                document.getElementById('loading-spinner').style.display = 'none';
                return;
            }
            
            appendProducts(data.products);
            loading = false;
        })
        .catch(err => {
            console.error('Error loading products:', err);
            loading = false;
        });
}

// Append products to grid
function appendProducts(products) {
    const grid = document.getElementById('product-grid');
    if (!grid) return;
    
    products.forEach(product => {
        const productHtml = `
            <div class="col-lg-3 col-md-4 col-sm-6">
                <div class="card product-card">
                    <div class="card-image">
                        <span class="card-badge">${product.brand}</span>
                        <img src="${product.image_url}" alt="${product.name}">
                    </div>
                    <div class="card-content">
                        <div class="card-category">${product.category}</div>
                        <h3 class="card-title">${product.name}</h3>
                        <div class="card-price">₹${product.price}</div>
                        <a href="/product/${product.id}" class="btn btn-primary w-100">View Details</a>
                    </div>
                </div>
            </div>
        `;
        grid.insertAdjacentHTML('beforeend', productHtml);
    });
}

// Payment proof upload preview
function previewPaymentProof(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        
        reader.onload = function(e) {
            const preview = document.getElementById('proof-preview');
            preview.innerHTML = `<img src="${e.target.result}" class="img-fluid mt-3" style="max-height: 200px;">`;
        };
        
        reader.readAsDataURL(input.files[0]);
    }
}

// Admin actions
function banUser(userId, action) {
    if (!confirm(`Are you sure you want to ${action} this user?`)) return;
    
    fetch(`/admin/users/${userId}/ban`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showNotification(`User ${action}ned successfully`, 'success');
            setTimeout(() => location.reload(), 1000);
        } else {
            showNotification(data.error || `Failed to ${action} user`, 'error');
        }
    })
    .catch(err => {
        console.error('Error:', err);
        showNotification('An error occurred', 'error');
    });
}

function updateOrderStatus(orderId, status) {
    fetch(`/admin/orders/${orderId}/status`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showNotification('Order status updated', 'success');
            setTimeout(() => location.reload(), 1000);
        } else {
            showNotification(data.error || 'Failed to update status', 'error');
        }
    })
    .catch(err => {
        console.error('Error:', err);
        showNotification('An error occurred', 'error');
    });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    // Update cart count
    updateCartCount();
    
    // Setup search input
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => searchProducts(e.target.value));
    }
    
    // Setup payment proof upload
    const proofInput = document.getElementById('payment-proof');
    if (proofInput) {
        proofInput.addEventListener('change', (e) => previewPaymentProof(e.target));
    }
    
    // Setup quantity inputs
    const quantityInputs = document.querySelectorAll('.quantity-input');
    quantityInputs.forEach(input => {
        input.addEventListener('change', function() {
            if (this.value < 1) this.value = 1;
        });
    });
});
