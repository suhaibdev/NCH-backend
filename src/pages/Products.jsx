import React from 'react';

const Products = () => {
  // Mock data array for dynamic rendering
  const productList = [
    { id: 1, name: 'Cotton Crepe Bandage', img: '/nch-client-rsbuild/src/images/crepe-bandage.jpg', desc: 'High elasticity and comfortable support for joints.' },
    { id: 2, name: 'Absorbent Gauze Roll', img: '/assets/images/gauze-roll.jpg', desc: '100% pure cotton, highly absorbent and sterile.' },
    { id: 3, name: 'Medical Bandage', img: '/assets/images/hero-bandage.jpg', desc: 'Standard medical grade bandages for daily clinic use.' },
  ];

  return (
    <section className="products-section" id="products">
      <div className="container">
        <h2 className="section-title">Our Products</h2>
        <div className="products-grid">
          {productList.map(product => (
            <article className="product-card" key={product.id}>
              <div className="img-placeholder">
                <img src={product.img} alt={`Image of ${product.name}`} />
              </div>
              <h3>{product.name}</h3>
              <p>{product.desc}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Products;